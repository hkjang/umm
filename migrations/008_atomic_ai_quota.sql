-- v0.8.1 makes the daily AI limit a reservation rather than a count-then-act
-- check. Short-lived rows coordinate concurrent requests across all replicas;
-- ai_calls remains the durable usage ledger.

CREATE TABLE IF NOT EXISTS ai_quota_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS ai_quota_reservations_user_expiry_idx
  ON ai_quota_reservations(user_id, expires_at);

CREATE INDEX IF NOT EXISTS ai_quota_reservations_expiry_idx
  ON ai_quota_reservations(expires_at);
