CREATE TABLE sandbox_boards (
  id uuid PRIMARY KEY,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  name text NOT NULL,
  bundle_json text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
CREATE INDEX sandbox_boards_classroom_idx ON sandbox_boards(classroom_id, created_at);
ALTER TABLE classroom_workspace DROP CONSTRAINT IF EXISTS classroom_workspace_kind_check;
ALTER TABLE classroom_workspace ADD CONSTRAINT classroom_workspace_kind_check CHECK(kind IN ('document','geogebra','presentation','sandbox'));
ALTER TABLE classroom_workspace ADD COLUMN sandbox_id uuid REFERENCES sandbox_boards(id) ON DELETE SET NULL;
