const { createClient } = require('redis');
const axios = require('axios');

const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on('error', err => console.error('Redis Client Error', err));

// =====================================
// Worker State
// =====================================
let globalRateLimit = 10; // default deliveries per second
let currentDelayMs = 1000 / globalRateLimit;
let currentUserIndex = 0;

// Fetch rate limit configuration dynamically
async function updateRateLimit() {
  try {
    const limitStr = await redisClient.get('global_rate_limit');
    if (limitStr) {
      const limit = parseInt(limitStr, 10);
      if (limit > 0 && limit !== globalRateLimit) {
        globalRateLimit = limit;
        currentDelayMs = 1000 / globalRateLimit;
        console.log(`[Rate Limit Updated] ${globalRateLimit} deliveries/sec (delay: ${currentDelayMs}ms)`);
      }
    }
  } catch (err) {
    console.error('Error fetching rate limit:', err);
  }
}

// Poll configuration every 5 seconds
setInterval(updateRateLimit, 5000);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function processNextJob() {
  try {
    // 1. Get Set of active users (who have pending jobs)
    const activeUsers = await redisClient.sMembers('active_users');
    
    if (activeUsers.length === 0) {
      // No active users, sleep briefly to avoid CPU spin
      await sleep(100);
      return;
    }

    // 2. Select next user in Round-Robin fashion
    if (currentUserIndex >= activeUsers.length) {
      currentUserIndex = 0;
    }
    
    const userId = activeUsers[currentUserIndex];
    currentUserIndex++; 
    
    // 3. Pop the oldest job from this user's specific queue (FIFO)
    const queueName = `user_jobs:${userId}`;
    const jobStr = await redisClient.rPop(queueName);
    
    if (!jobStr) {
      // This user has no more jobs, remove them from active users
      await redisClient.sRem('active_users', userId);
      // Immediately loop again (without consuming a rate limit token)
      // We return a small delay to prevent call stack issues
      await sleep(1);
      return;
    }

    // 4. Fire the webhook delivery
    const job = JSON.parse(jobStr);
    
    try {
      const startTime = Date.now();
      await axios.post(job.target_url, job.payload, {
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'WebhookDeliverySystem/1.0'
        },
        timeout: 5000 // 5 second timeout
      });
      const latency = Date.now() - job.timestamp;
      console.log(`[${new Date().toISOString()}] [Success] User:${userId} | Tgt:${job.target_url} | Event:${job.event_type} | Wait:${latency}ms`);
    } catch (err) {
      console.log(`[${new Date().toISOString()}] [Failed] User:${userId} | Tgt:${job.target_url} | Err:${err.message}`);
    }

    // 5. Sleep to strictly enforce the Global Rate Limit (Part B)
    // E.g., if limit is 10/sec, delay is 100ms between deliveries.
    await sleep(currentDelayMs);

  } catch (err) {
    console.error('Worker encountered error in run loop:', err);
    await sleep(1000); // Backoff briefly on unexpected fatal error
  }
}

async function startWorker() {
  await redisClient.connect();
  console.log('Worker started. Awaiting webhook jobs...');
  
  // Initial config load
  await updateRateLimit();

  // The infinite processing loop
  while (true) {
    await processNextJob();
  }
}

startWorker().catch(console.error);
