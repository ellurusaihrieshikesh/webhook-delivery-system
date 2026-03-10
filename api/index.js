const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// 1. PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://webhook_user:webhook_password@localhost:5432/webhooks_db'
});

// 2. Redis connection
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

// Valid event types
const VALID_EVENTS = ['request.created', 'request.updated', 'request.deleted'];

// Helper to get user_id from headers
const requireUser = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Missing X-User-Id header' });
  }
  req.userId = userId;
  next();
};

// ==========================================
// Webhook CRUD API
// ==========================================

// Register Webhook
app.post('/webhooks', requireUser, async (req, res) => {
  const { target_url, event_types } = req.body;
  if (!target_url || !Array.isArray(event_types) || event_types.length === 0) {
    return res.status(400).json({ error: 'target_url and non-empty event_types array are required' });
  }
  
  const invalidEvents = event_types.filter(e => !VALID_EVENTS.includes(e));
  if (invalidEvents.length > 0) {
    return res.status(400).json({ error: `Invalid event_types: ${invalidEvents.join(', ')}` });
  }

  const id = uuidv4();
  try {
    await pool.query(
      `INSERT INTO webhooks (id, user_id, target_url, event_types, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.userId, target_url, JSON.stringify(event_types), true]
    );
    res.status(201).json({ id, target_url, event_types, is_active: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List Webhooks
app.get('/webhooks', requireUser, async (req, res) => {
  try {
    let query = 'SELECT id, target_url, event_types, is_active, created_at FROM webhooks WHERE user_id = $1';
    const params = [req.userId];
    
    if (req.query.status !== undefined) {
      const isActive = req.query.status === 'active';
      query += ' AND is_active = $2';
      params.push(isActive);
    }
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Webhook
app.put('/webhooks/:id', requireUser, async (req, res) => {
  const { target_url, event_types } = req.body;
  const { id } = req.params;

  let updateFields = [];
  let params = [id, req.userId];
  let paramIndex = 3;

  if (target_url) {
    updateFields.push(`target_url = $${paramIndex++}`);
    params.push(target_url);
  }
  if (event_types) {
    const invalidEvents = event_types.filter(e => !VALID_EVENTS.includes(e));
    if (invalidEvents.length > 0) {
      return res.status(400).json({ error: `Invalid event_types: ${invalidEvents.join(', ')}` });
    }
    updateFields.push(`event_types = $${paramIndex++}`);
    params.push(JSON.stringify(event_types));
  }

  if (updateFields.length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  
  updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

  try {
    const result = await pool.query(
      `UPDATE webhooks SET ${updateFields.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
      params
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Webhook
app.delete('/webhooks/:id', requireUser, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM webhooks WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle Webhook
app.patch('/webhooks/:id/toggle', requireUser, async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be a boolean' });
  }
  
  try {
    const result = await pool.query(
      `UPDATE webhooks SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3 RETURNING *`,
      [is_active, req.params.id, req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Event Ingestion API
// ==========================================

app.post('/events', requireUser, async (req, res) => {
  const { event_type, payload } = req.body;
  const userId = req.userId;

  if (!event_type || !VALID_EVENTS.includes(event_type)) {
    return res.status(400).json({ error: 'Invalid or missing event_type' });
  }

  try {
    // Find matching active webhooks for this user
    const result = await pool.query(
      `SELECT target_url FROM webhooks 
       WHERE user_id = $1 AND is_active = true AND event_types @> $2::jsonb`,
      [userId, JSON.stringify([event_type])]
    );

    const webhooks = result.rows;
    if (webhooks.length === 0) {
      // No active webhooks matching the event
      return res.status(202).json({ message: 'Event ingested, but no active matching webhooks found' });
    }

    // Prepare jobs for the queue
    const multi = redisClient.multi();
    
    // Add user to the active_users set
    multi.sAdd('active_users', userId);
    
    // Push jobs to the user's specific queue
    const queueKey = `queue:user:${userId}`;
    webhooks.forEach(wh => {
      const job = {
        target_url: wh.target_url,
        event_type,
        payload,
        queued_at: Date.now()
      };
      multi.rPush(queueKey, JSON.stringify(job));
    });

    await multi.exec();

    res.status(202).json({ 
      message: 'Event ingested and enqueued for delivery',
      deliveries_queued: webhooks.length 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// Rate Limit Configuration API
// ==========================================

app.get('/rate-limit', async (req, res) => {
  try {
    const limit = await redisClient.get('global_rate_limit');
    res.json({ rate_limit_per_second: limit ? parseInt(limit, 10) : 10 }); // Default 10
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/rate-limit', async (req, res) => {
  const { rate_limit } = req.body;
  if (!Number.isInteger(rate_limit) || rate_limit <= 0) {
    return res.status(400).json({ error: 'rate_limit must be a positive integer' });
  }

  try {
    await redisClient.set('global_rate_limit', rate_limit.toString());
    res.json({ message: 'Rate limit updated', rate_limit_per_second: rate_limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await redisClient.connect();
  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`);
  });
}

start().catch(console.error);
