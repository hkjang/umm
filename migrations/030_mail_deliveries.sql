-- Event notifications through the company SMTP relay.
--
-- Somebody is waiting: a reviewer for a request they do not know exists, a
-- requester for a decision, a person for the space just shared with them, a
-- name called in a comment. Until now the only way to learn any of it was to
-- open umm and look. This row lets an administrator point umm at the relay so
-- those five things arrive as mail.
--
-- Seeded off, with the relay defaults an internal network usually has (port
-- 25, no credentials, TLS only if offered). A new installation sends nothing
-- until an administrator turns the switch. The password is stored encrypted
-- like the other secrets in app_settings and is never handed back by the API.
INSERT INTO app_settings(key, value, updated_at)
VALUES ('mail', jsonb_build_object(
  'enabled', false,
  'smtp_host', '',
  'smtp_port', 25,
  'security', 'auto',
  'skip_tls_verify', false,
  'username', '',
  'password', '',
  'from_address', '',
  'from_name', 'umm',
  'base_url', '',
  'timeout_seconds', 10,
  'notify_approval_request', true,
  'notify_approval_decision', true,
  'notify_space_shared', true,
  'notify_mention', true,
  'notify_comment', true
), now())
ON CONFLICT (key) DO NOTHING;

-- What left the building: one row per attempt to one address, with the
-- outcome. The subject and the recipient are enough to answer "it never
-- arrived"; the body is deliberately not here, so this table can never
-- become the copy of a comment that somebody was not meant to read.
--
-- No foreign keys: a record of what was sent outlives the space and the
-- account it was about.
CREATE TABLE IF NOT EXISTS mail_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  space_id uuid,
  actor_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts int NOT NULL DEFAULT 0,
  error_message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_deliveries_created_idx ON mail_deliveries(created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('030_mail_deliveries')
  ON CONFLICT DO NOTHING;
