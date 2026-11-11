ALTER TABLE classrooms ADD COLUMN enrollment_mode ENUM('assigned','organization') NOT NULL DEFAULT 'assigned';
-- statement
CREATE TABLE classroom_memberships (
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY(classroom_id,user_id),
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX classroom_memberships_user(user_id)
) ENGINE=InnoDB;
-- statement
INSERT INTO classroom_memberships(classroom_id,user_id)
SELECT c.id,m.user_id FROM classrooms c JOIN memberships m ON m.organization_id=c.organization_id WHERE m.role<>'owner';
