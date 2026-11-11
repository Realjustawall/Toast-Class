ALTER TABLE classrooms ADD COLUMN enrollment_mode text NOT NULL DEFAULT 'assigned' CHECK(enrollment_mode IN ('assigned','organization'));
CREATE TABLE classroom_memberships (
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(classroom_id,user_id)
);
CREATE INDEX classroom_memberships_user ON classroom_memberships(user_id);
INSERT INTO classroom_memberships(classroom_id,user_id)
SELECT c.id,m.user_id FROM classrooms c JOIN memberships m ON m.organization_id=c.organization_id WHERE m.role<>'owner';
