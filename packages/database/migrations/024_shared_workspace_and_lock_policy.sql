ALTER TABLE classrooms ADD COLUMN locks_json text;
ALTER TABLE classrooms ADD COLUMN lock_revision integer NOT NULL DEFAULT 0;
ALTER TABLE classrooms ADD COLUMN selected_student_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE classroom_user_permissions ADD COLUMN can_shared_notes boolean;
ALTER TABLE classroom_user_permissions ADD COLUMN lock_exempt boolean NOT NULL DEFAULT false;
ALTER TABLE classroom_user_permissions ADD COLUMN revision integer NOT NULL DEFAULT 0;
CREATE TABLE classroom_workspace (
  classroom_id uuid PRIMARY KEY REFERENCES classrooms(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'document' CHECK(kind IN ('document','geogebra','presentation')),
  document_id uuid REFERENCES collaborative_documents(id) ON DELETE SET NULL,
  geogebra_id uuid REFERENCES geogebra_documents(id) ON DELETE SET NULL,
  geo_perspective text NOT NULL DEFAULT '1',
  revision integer NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
