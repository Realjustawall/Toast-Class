CREATE TABLE geogebra_documents (
  id uuid PRIMARY KEY,
  classroom_id uuid NOT NULL REFERENCES classrooms(id),
  name varchar(120) NOT NULL,
  state_base64 text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX geogebra_room ON geogebra_documents(classroom_id,created_at);
