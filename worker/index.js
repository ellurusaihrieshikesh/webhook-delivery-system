const { createClient } = require('redis');
const axios = require('axios');

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

let tokens = 0;
let lastRefill = Date.now();

async function getGlobalRateLimit() {
  const limitStr = await redisClient.get('global_rate_limit');
  return limitStr ? parseInt(limitStr, 10) : 10; // Default 10 per second
}

// Refill tokens periodically based on rate limit
async function refillTokens() {
  const rateLimit = await getGlobalRateLimit();
  const now = Date.now();
  const timePassedMs = now - lastRefill;
  
  // How many tokens should we add based on time passed
  const tokensToAdd = (timePassedMs / 1000) * rateLimit;
  
  if (tokensToAdd >= 1) {
    tokens = Math.min(rateLimit, tokens + tokensToAdd);
    lastRefill = now;
  }
}

// Retrieve list of active users and keep track of our round-robin index
let currentUserIndex = 0;

async function processQueue() {
  try {
    await refillTokens();

    if (tokens < 1) {
      // Out of tokens, wait briefly and try again
      setTimeout(processQueue, 50);
      return;
    }

    // Get all active users
    const activeUsers = await redisClient.sMembers('active_users');
    
    if (activeUsers.length === 0) {
      // No active users, wait briefly
      setTimeout(processQueue, 100);
      return;
    }

    // Fairness: Round Robin selection
    if (currentUserIndex >= activeUsers.length) {
      currentUserIndex = 0;
    }

    const userId = activeUsers[currentUserIndex];
    const queueKey = `queue:user:${userId}`;

    // Try to pop a job for this user
    const jobStr = await redisClient.lPop(queueKey);

    if (!jobStr) {
      // User has no more jobs, remove from active_users
      await redisClient.sRem('active_users', userId);
      // Give back the token since we didn't do work
      // No need to change currentUserIndex, next user will shift into this spot
      setImmediate(processQueue);
      return;
    }

    // We have a job, consume a token
    tokens -= 1;
    
    // Move to next user for fairness
    currentUserIndex++;

    const job = JSON.parse(jobStr);
    
    // Execute POST request asynchronously (fire and forget for queue loop speed)
    deliverWebhook(job);

    // Continue loop immediately since we consumed a token and dispatched a job
    setImmediate(processQueue);
    
  } catch (err) {
    console.error('Error in worker loop:', err);
    setTimeout(processQueue, 1000);
  }
}

async function deliverWebhook(job) {
  const { target_url, event_type, payload } = job;
  try {
    const res = await axios.post(target_url, {
      event_type,
      payload,
      timestamp: new Date().toISOString()
    }, { timeout: 10000 });
    
    console.log(`[OK] Delivered ${event_type} to ${target_url} - Status ${res.status}`);
  } catch (err) {
    console.log(`[FAIL] Delivered ${event_type} to ${target_url} - Error: ${err.message}`);
    // "Retries: If a delivery fails (non-2xx or timeout), log the failure and move on. Retry logic is out of scope."
  }
}

async function start() {
  await redisClient.connect();
  console.log('Worker started');
  lastRefill = Date.now();
  processQueue();
}

start().catch(console.error);
