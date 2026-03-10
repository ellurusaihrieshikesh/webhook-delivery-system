const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createClient } = require('redis');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on('error', err => console.error('Redis Client Error', err));

// Middleware to extract X-User-Id for CRUD operations
const extractUser = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Missing X-User-Id header' });
  }
  req.userId = userId;
  next();
};

// Healthcheck
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ==========================================
// Webhook CRUD API
// ==========================================

// Register Webhook
app.post('/webhooks', extractUser, async (req, res) => {
  const { target_url, events } = req.body;
  if (!target_url || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'target_url and events array are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO webhooks (user_id, target_url, events) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, target_url, JSON.stringify(events)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List Webhooks (supports ?status=active)
app.get('/webhooks', extractUser, async (req, res) => {
  const { status } = req.query;
  let query = 'SELECT * FROM webhooks WHERE user_id = $1';
  const params = [req.userId];

  if (status === 'active') {
    query += ' AND is_active = true';
  } else if (status === 'disabled') {
    query += ' AND is_active = false';
  }

  try {
    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching webhooks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Webhook
app.put('/webhooks/:id', extractUser, async (req, res) => {
  const { id } = req.params;
  const { target_url, events } = req.body;

  if (!target_url || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'target_url and events array are required' });
  }

  try {
    const result = await pool.query(
      'UPDATE webhooks SET target_url = $1, events = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND user_id = $4 RETURNING *',
      [target_url, JSON.stringify(events), id, req.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error updating webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Webhook
app.delete('/webhooks/:id', extractUser, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM webhooks WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('Error deleting webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle Webhook Status
app.patch('/webhooks/:id/toggle', extractUser, async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active boolean is required' });
  }

  try {
    const result = await pool.query(
      'UPDATE webhooks SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3 RETURNING *',
      [is_active, id, req.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error toggling webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Internal APIs (Event Ingestion & Config)
// ==========================================

app.post('/internal/events', async (req, res) => {
  const { user_id, event_type, payload } = req.body;

  if (!user_id || !event_type || !payload) {
    return res.status(400).json({ error: 'user_id, event_type, and payload are required' });
  }

  try {
    // 1. Find all active webhooks for this user subscribed to this event
    // We use the JSONB contains operator @> to check if the event_type is in the events array.
    const result = await pool.query(
      `SELECT id, target_url FROM webhooks 
       WHERE user_id = $1 
         AND is_active = true 
         AND events @> $2::jsonb`,
      [user_id, JSON.stringify([event_type])]
    );

    const webhooks = result.rows;

    if (webhooks.length === 0) {
      return res.status(200).json({ message: 'Event ingested, no matching webhooks found.' });
    }

    // 2. Fan-out deliveries to queues
    const pipeline = redisClient.multi();
    const queueName = `user_jobs:${user_id}`; // Per-user queue (Part C Fairness)

    for (const webhook of webhooks) {
      const job = {
        id: webhook.id,
        user_id,
        target_url: webhook.target_url,
        event_type,
        payload,
        timestamp: Date.now()
      };
      
      // Push job to user's specific queue
      pipeline.lPush(queueName, JSON.stringify(job));
    }
    
    // Add user to the active users set for Round-Robin polling
    pipeline.sAdd('active_users', user_id);

    await pipeline.exec();

    res.status(202).json({ 
      message: 'Event ingested and deliveries scheduled.',
      webhook_count: webhooks.length 
    });

  } catch (err) {
    console.error('Error processing event:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Part B: Rate Limit Configuration
app.post('/internal/config/rate-limit', async (req, res) => {
  const { deliveries_per_second } = req.body;
  if (!deliveries_per_second || typeof deliveries_per_second !== 'number') {
    return res.status(400).json({ error: 'deliveries_per_second number is required' });
  }

  try {
    await redisClient.set('global_rate_limit', deliveries_per_second.toString());
    res.status(200).json({ message: 'Rate limit updated', limits: deliveries_per_second });
  } catch (err) {
    console.error('Error updating rate limit:', err);
    res.status(500).json({ error: 'Failed to update rate limit' });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await redisClient.connect();
  
  // Set default global rate limit to 10 if not set
  const exists = await redisClient.exists('global_rate_limit');
  if (!exists) {
    await redisClient.set('global_rate_limit', '10');
  }

  app.listen(PORT, () => {
    console.log(`API Server running on port ${PORT}`);
  });
}

start().catch(console.error);
