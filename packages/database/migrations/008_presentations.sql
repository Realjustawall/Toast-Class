ALTER TABLE files ADD COLUMN purpose text NOT NULL DEFAULT 'resource' CHECK(purpose IN ('resource','presentation'));
ALTER TABLE files ADD CONSTRAINT files_organization_pair UNIQUE(id,organization_id);
CREATE TABLE presentations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), classroom_id uuid NOT NULL REFERENCES classrooms(id),
 source_file_id uuid NOT NULL REFERENCES files(id), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 status text NOT NULL CHECK(status IN ('queued','processing','scanning','ready','failed','deleting','deleted')),
 generation uuid NOT NULL, claim uuid, claimed_until timestamptz,
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 page_count integer CHECK(page_count IS NULL OR page_count BETWEEN 1 AND 200),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), failure_code text,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), UNIQUE(id,classroom_id),
 FOREIGN KEY(classroom_id,organization_id) REFERENCES classrooms(id,organization_id),
 FOREIGN KEY(source_file_id,organization_id) REFERENCES files(id,organization_id),
 CHECK(status='processing' OR (claim IS NULL AND claimed_until IS NULL))
);
CREATE INDEX presentations_jobs ON presentations(status,created_at);
CREATE INDEX presentations_room ON presentations(classroom_id,created_at);
CREATE TABLE presentation_assets (
 presentation_id uuid NOT NULL REFERENCES presentations(id), organization_id uuid NOT NULL REFERENCES organizations(id),
 generation uuid NOT NULL, file_id uuid NOT NULL UNIQUE REFERENCES files(id),
 page_number integer NOT NULL CHECK(page_number BETWEEN 0 AND 200),
 width integer, height integer,
 PRIMARY KEY(presentation_id,generation,page_number),
 FOREIGN KEY(presentation_id,organization_id) REFERENCES presentations(id,organization_id),
 FOREIGN KEY(file_id,organization_id) REFERENCES files(id,organization_id),
 CHECK((page_number=0 AND width IS NULL AND height IS NULL) OR
       (page_number>0 AND width BETWEEN 1 AND 1600 AND height BETWEEN 1 AND 1600))
);
ALTER TABLE classroom_sessions ADD CONSTRAINT sessions_classroom_pair UNIQUE(id,classroom_id);
CREATE TABLE session_presentations (
 session_id uuid PRIMARY KEY REFERENCES classroom_sessions(id), classroom_id uuid NOT NULL REFERENCES classrooms(id),
 presentation_id uuid REFERENCES presentations(id),
 page_number integer CHECK(page_number IS NULL OR page_number BETWEEN 1 AND 200), independent_view boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), changed_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(session_id,classroom_id) REFERENCES classroom_sessions(id,classroom_id),
 FOREIGN KEY(presentation_id,classroom_id) REFERENCES presentations(id,classroom_id),
 CHECK((presentation_id IS NULL)=(page_number IS NULL))
);
