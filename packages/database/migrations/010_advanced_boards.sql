ALTER TABLE collaborative_documents ADD COLUMN board_format text NOT NULL DEFAULT 'legacy' CHECK(board_format IN ('legacy','excalidraw'));
ALTER TABLE collaborative_documents ADD CONSTRAINT board_format_kind CHECK(kind='board' OR board_format='legacy');
CREATE TABLE board_states (
 document_id uuid PRIMARY KEY REFERENCES collaborative_documents(id), generation uuid NOT NULL,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), state_base64 text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(), CHECK(length(state_base64)<=4000000)
);
CREATE TABLE board_receipts (
 document_id uuid NOT NULL REFERENCES collaborative_documents(id), update_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), digest text NOT NULL CHECK(length(digest)=64),
 update_base64 text, author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(document_id,update_id), UNIQUE(document_id,revision)
);
CREATE INDEX board_receipts_revision ON board_receipts(document_id,revision);
