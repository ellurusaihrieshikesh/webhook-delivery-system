# Webhook Delivery System

A reliable webhook delivery system where users can register HTTP endpoints, subscribe to specific events (`request.created`, `request.updated`, `request.deleted`), and receive real-time payloads.

## Features Let's you...
- **Webhook Management**: Register, list, update, delete, and enable/disable webhooks.
- **Event Fan Out**: Send events to `/events`, and it gets delivered to any active webhook subscribed to it.
- **Global Rate Limiting**: Deliveries are rate-limited via a Token Bucket algorithm. Cap is dynamically configurable at runtime.
- **User Fairness**: Ensures one user flooding the system with events does not delay deliveries for other users.

## Project Structure
- `api/`: Express.js service handling Webhook CRUD, Event Ingestion, and Rate Limit Configuration.
- `worker/`: Node.js process acting as a consumer. Pulls jobs from Redis, respects global rate limits, scheduling jobs fairly across users, and POSTs to webhook URLs.
- `receiver/`: Mock receiver service to log incoming webhook deliveries. 
- `db/`: Contains PostgreSQL `init.sql` schema scripts.

## Setup & Running with Docker Compose

1. **Ensure Docker is running** on your machine.
2. In the project root, run:
   ```bash
   docker compose up --build
   ```
3. Use the following ports mapping:
   - `3000`: API
   - `4000`: Mock Receiver (Target your webhook URL to `http://receiver:4000/some-path`)
   - `5432`: PostgreSQL
   - `6379`: Redis

## API Usage Example

**1. Create a webhook:**
```bash
curl -X POST http://localhost:3000/webhooks \
  -H "X-User-Id: user_123" \
  -H "Content-Type: application/json" \
  -d '{
    "target_url": "http://receiver:4000/my-webhook-endpoint",
    "event_types": ["request.created", "request.updated"]
  }'
```

**2. Ingest an event:**
```bash
curl -X POST http://localhost:3000/events \
  -H "X-User-Id: user_123" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "request.created",
    "payload": { "id": "1", "data": "test" }
  }'
```

**3. Change Rate Limit:**
```bash
curl -X PUT http://localhost:3000/rate-limit \
  -H "Content-Type: application/json" \
  -d '{"rate_limit": 50}'
```

## Architecture and Design Decisions

### Datastores
- **PostgreSQL**: Used for Webhook configs because storing structured, relation-like data (webhooks belonging to users) and querying by subsets of `event_types` works elegantly with JSONB indexes.
- **Redis**: Used as the queuing state store and rate limiting store. Redis's primitives (`Lists`, `Sets`) make building strict round-robin user fairness incredibly fast without relying on enterprise features of typical queue brokers.

### Queueing and Multi-User Fairness Strategy (Part C)
When an event is ingested, we `RPUSH` it to a list specific to the user (`queue:user:{user_id}`) and add the user to a global set of `active_users` with pending jobs.

The worker implements a **Round-Robin Scheduler**:
1. Iterates continuously through the global `active_users` list.
2. Pops exactly **one** job for the current user in turn (`LPOP queue:user:{user_id}`).
3. If a user's queue becomes empty, we remove them from `active_users` (`SREM`).
4. By continuously looping across active users and taking 1 job per turn, User B's small batch of deliveries will be processed interleaved with User A's large batch. User B is not starved or queued strictly behind User A, giving us true multi-user fairness.

### Rate Limiting Strategy (Part B)
A **Token Bucket** algorithm limits the overall system outbound throughput.
- Tokens are restored continuously at the rate of `rate_limit_per_second` (default 10) up to the cap.
- Before the worker attempts to process a job, it checks token availability. If tokens < 1, the worker yields via `setTimeout`.
- If a token is available, the worker subtracts 1 and pops the next job. This ensures that across bursts of traffic, we strictly adhere to the cap limit set dynamically into Redis.
