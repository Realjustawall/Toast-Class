ALTER TABLE audit_logs ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE audit_logs ADD COLUMN actor_kind text NOT NULL DEFAULT 'user';
ALTER TABLE audit_logs ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE audit_logs ADD CONSTRAINT audit_actor_kind CHECK(actor_kind IN ('user','system'));
ALTER TABLE audit_logs ADD CONSTRAINT audit_user_actor CHECK(actor_kind='system' OR actor_id IS NOT NULL);
CREATE TABLE breakout_groups (
 id uuid PRIMARY KEY, parent_session_id uuid NOT NULL REFERENCES classroom_sessions(id),
 active_key uuid UNIQUE REFERENCES classroom_sessions(id), status text NOT NULL CHECK(status IN ('active','closed')),
 ends_at timestamptz NOT NULL, allow_self_select boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 CHECK(active_key IS NULL OR active_key=parent_session_id)
);
CREATE INDEX breakout_groups_expiry ON breakout_groups(status,ends_at);
CREATE TABLE breakout_rooms (
 classroom_id uuid PRIMARY KEY REFERENCES classrooms(id), group_id uuid NOT NULL REFERENCES breakout_groups(id),
 session_id uuid UNIQUE NOT NULL REFERENCES classroom_sessions(id), position integer NOT NULL,
 UNIQUE(group_id,position)
);
CREATE INDEX breakout_rooms_group ON breakout_rooms(group_id);
CREATE TABLE breakout_assignments (
 group_id uuid NOT NULL REFERENCES breakout_groups(id), user_id uuid NOT NULL REFERENCES users(id),
 room_id uuid REFERENCES breakout_rooms(classroom_id), revision integer NOT NULL DEFAULT 1,
 assigned_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(group_id,user_id)
);
CREATE TABLE breakout_assignment_events (
 id uuid PRIMARY KEY, group_id uuid NOT NULL REFERENCES breakout_groups(id), user_id uuid NOT NULL REFERENCES users(id),
 room_id uuid REFERENCES breakout_rooms(classroom_id), revision integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(group_id,user_id,revision)
);
CREATE TABLE breakout_announcements (
 id uuid PRIMARY KEY, group_id uuid NOT NULL REFERENCES breakout_groups(id), body text NOT NULL,
 sent_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE collaborative_documents ADD COLUMN source_document_id uuid REFERENCES collaborative_documents(id);
