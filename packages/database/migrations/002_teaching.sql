CREATE TABLE classroom_sessions (
 id uuid PRIMARY KEY, classroom_id uuid NOT NULL REFERENCES classrooms(id), started_by uuid NOT NULL REFERENCES users(id),
 started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 active_key uuid UNIQUE REFERENCES classrooms(id), CHECK (active_key IS NULL OR active_key=classroom_id)
);
CREATE TABLE hand_raises (
 session_id uuid NOT NULL REFERENCES classroom_sessions(id), user_id uuid NOT NULL REFERENCES users(id),
 raised_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,user_id)
);
CREATE TABLE classroom_timers (
 session_id uuid PRIMARY KEY REFERENCES classroom_sessions(id), duration_seconds integer NOT NULL CHECK(duration_seconds BETWEEN 1 AND 86400),
 remaining_ms integer NOT NULL, deadline timestamptz, status text NOT NULL CHECK(status IN ('running','paused','stopped'))
);
CREATE TABLE polls (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES classroom_sessions(id), question text NOT NULL,
 options jsonb NOT NULL, status text NOT NULL CHECK(status IN ('draft','open','paused','ended')),
 results_published boolean NOT NULL DEFAULT false, closes_at timestamptz, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE poll_responses (
 poll_id uuid NOT NULL REFERENCES polls(id), user_id uuid NOT NULL REFERENCES users(id), choice integer NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(poll_id,user_id)
);
CREATE INDEX polls_session ON polls(session_id,created_at);
CREATE TABLE collaborative_documents (
 id uuid PRIMARY KEY, classroom_id uuid NOT NULL REFERENCES classrooms(id), kind text NOT NULL CHECK(kind IN ('notes','board')),
 name text NOT NULL, teacher_only boolean NOT NULL DEFAULT false, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE document_updates (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES collaborative_documents(id), author_id uuid NOT NULL REFERENCES users(id),
 update_base64 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_updates_doc ON document_updates(document_id);
