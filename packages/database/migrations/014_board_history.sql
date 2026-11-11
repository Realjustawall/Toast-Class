CREATE TABLE board_versions (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES collaborative_documents(id),
 generation uuid NOT NULL, revision integer NOT NULL CHECK(revision>=0),
 label text NOT NULL CHECK(length(label)<=120), kind text NOT NULL CHECK(kind IN ('manual','automatic','before_restore')),
 state_base64 text NOT NULL CHECK(length(state_base64)<=4000000), digest text NOT NULL CHECK(length(digest)=64),
 author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_versions_document_time ON board_versions(document_id,created_at,id);
CREATE TABLE board_restore_operations (
 document_id uuid NOT NULL REFERENCES collaborative_documents(id), operation_id uuid NOT NULL,
 digest text NOT NULL CHECK(length(digest)=64), generation uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(document_id,operation_id)
);
