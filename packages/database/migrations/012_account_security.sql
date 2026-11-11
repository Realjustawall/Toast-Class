ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'fa' CHECK(locale IN ('fa','en'));
ALTER TABLE users ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Tehran';
ALTER TABLE auth_sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_public_id UNIQUE(id);
ALTER TABLE auth_sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE auth_sessions ADD COLUMN user_agent text NOT NULL DEFAULT '';
CREATE INDEX auth_sessions_user ON auth_sessions(user_id,expires_at);
CREATE TABLE account_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_security_events_user_time ON account_security_events(user_id,created_at DESC,id DESC);
