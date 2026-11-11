CREATE TABLE board_presenter_views (
 document_id uuid PRIMARY KEY REFERENCES collaborative_documents(id),
 generation uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 active boolean NOT NULL,
 center_x double precision NOT NULL CHECK(center_x>=-10000000 AND center_x<=10000000),
 center_y double precision NOT NULL CHECK(center_y>=-10000000 AND center_y<=10000000),
 zoom double precision NOT NULL CHECK(zoom>=0.1 AND zoom<=10),
 actor_id uuid NOT NULL REFERENCES users(id), operation_id uuid NOT NULL,
 digest text NOT NULL CHECK(length(digest)=64),
 updated_at timestamptz NOT NULL DEFAULT now()
);
