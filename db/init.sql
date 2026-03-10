CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    target_url TEXT NOT NULL,
    event_types JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhooks_user_id ON webhooks(user_id);
