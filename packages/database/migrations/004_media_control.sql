CREATE TABLE media_permissions (
 session_id uuid NOT NULL REFERENCES classroom_sessions(id), user_id uuid NOT NULL REFERENCES users(id),
 microphone boolean NOT NULL DEFAULT true, camera boolean NOT NULL DEFAULT true, screen_share boolean NOT NULL DEFAULT true,
 blocked boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(session_id,user_id)
);
CREATE TABLE media_commands (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES classroom_sessions(id), user_id uuid REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('permissions','remove','delete_room')), payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX media_commands_pending ON media_commands(status,next_attempt_at);
