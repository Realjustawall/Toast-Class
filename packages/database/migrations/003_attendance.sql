CREATE TABLE media_webhook_events (
 id text PRIMARY KEY, body_hash text NOT NULL, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media_connections (
 id text PRIMARY KEY, classroom_id uuid NOT NULL REFERENCES classrooms(id), user_id uuid NOT NULL REFERENCES users(id),
 session_id uuid REFERENCES classroom_sessions(id), joined_at timestamptz, left_at timestamptz
);
CREATE INDEX media_connections_room ON media_connections(classroom_id,user_id);
