# Webhook Delivery System

A robust, multi-user webhook delivery system built with **Node.js, Express, PostgreSQL, and Redis**. 
It handles webhook registration, event ingestion, rate-limited deliveries, and multi-user fairness queueing.

## Getting Started

To spin up the entire system (API, Worker, Mock-Receiver, Postgres, Redis), simply run:

\`\`\`bash
docker compose up --build
\`\`\`

The following services will be available:
- **API Server:** `http://localhost:3000`
- **Mock Receiver:** `http://localhost:3001`
- **PostgreSQL:** `localhost:5432`
- **Redis:** `localhost:6379`

---

## Architecture & Strategy

### 1. Queuing & Storage
- **PostgreSQL** is used as the primary source of truth for Webhook configurations. It allows for reliable ACID operations on user settings and complex querying (e.g., using `JSONB` for event types).
- **Redis** is utilized for ephemeral, high-throughput job queueing and rate-limit tracking.

### 2. Rate Limiting (Part B)
- **Strategy chosen:** **Global Sleep/Delay Interval** based on polling a dynamic rate limit value.
- **Why?** Since the worker is a single process pulling from Redis sequentially, complex Distributed Token Buckets aren't strictly necessary to achieve a clean output rate. By polling the `global_rate_limit` from Redis and sleeping `1000 / limit` milliseconds between successful pulls, the worker mathematically guarantees it will never exceed the specified deliveries per second.
- **Alternatives considered:** Redis `INCR` based rolling windows. However, that drops jobs when over limits. The requirement was to *queue* them, hence the delay approach is perfect to throttle consumption while preserving all queued jobs.

### 3. Multi-User Fairness (Part C)
- **Strategy chosen:** **Per-User Queues with Round-Robin Scheduling**.
- **How it works:** 
  1. When an event is ingested, the API pushes the job to a queue specifically named for that user (`user_jobs:<user_id>`). 
  2. It also adds the `<user_id>` to a Redis `SET` called `active_users`.
  3. The Worker fetches the `active_users` list and iterates through them in a continuous circle (Round-Robin).
  4. It pops exactly *one* job from User A, waits the rate-limit delay, pops *one* from User B, waits, etc.
- **Why?** This prevents the "noisy neighbor" or Head-of-Line blocking problem. If User A submits 10,000 jobs, they are constrained to their own queue. User B's single job is guaranteed to be processed on the Worker's very next cycle.
- **Alternatives considered:** Weighted Fair Queuing. However, that requires complex score calculations (ZSETs), whereas simple Round-Robin over dynamic queues is extremely lightweight and achieves the exact required outcome with perfect isolation.

---

## API Contracts & Specifications

### Authentication
Pass the `X-User-Id` header for all Webhook CRUD operations to identify the user.

### Webhook CRUD API

#### 1. Register Webhook
- **Endpoint:** `POST /webhooks`
- **Headers:** `X-User-Id: <string>`
- **Body:** `{ "target_url": "http://example.com/webhook", "events": ["request.created", "request.updated"] }`
- **Response `201 Created`:** Returns the webhook object (id, user_id, target_url, events, is_active).

#### 2. List Webhooks
- **Endpoint:** `GET /webhooks`
- **Headers:** `X-User-Id: <string>`
- **Query Params (Optional):** `?status=active` or `?status=disabled`
- **Response `200 OK`:** Array of webhook objects.

#### 3. Update Webhook
- **Endpoint:** `PUT /webhooks/:id`
- **Headers:** `X-User-Id: <string>`
- **Body:** `{ "target_url": "http://new-url.com", "events": ["request.deleted"] }`
- **Response `200 OK`:** Updated webhook object.

#### 4. Delete Webhook
- **Endpoint:** `DELETE /webhooks/:id`
- **Headers:** `X-User-Id: <string>`
- **Response `204 No Content`**

#### 5. Toggle Webhook
- **Endpoint:** `PATCH /webhooks/:id/toggle`
- **Headers:** `X-User-Id: <string>`
- **Body:** `{ "is_active": false }`
- **Response `200 OK`:** Updated webhook object.

---

### Internal APIs

#### 6. Event Ingestion
- **Endpoint:** `POST /internal/events`
- **Body:** `{ "user_id": "user-123", "event_type": "request.created", "payload": { "id": 1, "data": "test" } }`
- **Response `202 Accepted`:** `{ "message": "Event ingested and deliveries scheduled.", "webhook_count": 1 }`
- *No X-User-Id required here, user is passed in the body payload.*

#### 7. Update Global Rate Limit
- **Endpoint:** `POST /internal/config/rate-limit`
- **Body:** `{ "deliveries_per_second": 20 }`
- **Response `200 OK`:** `{ "message": "Rate limit updated", "limits": 20 }`
