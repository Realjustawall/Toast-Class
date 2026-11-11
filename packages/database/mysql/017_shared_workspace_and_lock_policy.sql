ALTER TABLE classrooms ADD COLUMN locks_json LONGTEXT NULL, ADD COLUMN lock_revision INT UNSIGNED NOT NULL DEFAULT 0;
-- statement
ALTER TABLE classrooms ADD COLUMN selected_student_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD CONSTRAINT classroom_selected_student FOREIGN KEY(selected_student_id) REFERENCES users(id) ON DELETE SET NULL;
-- statement
ALTER TABLE classroom_user_permissions ADD COLUMN can_shared_notes BOOLEAN NULL, ADD COLUMN lock_exempt BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 0;
-- statement
CREATE TABLE classroom_workspace (
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  kind ENUM('document','geogebra','presentation') NOT NULL DEFAULT 'document',
  document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  geogebra_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  geo_perspective VARCHAR(8) NOT NULL DEFAULT '1',
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES collaborative_documents(id) ON DELETE SET NULL,
  FOREIGN KEY (geogebra_id) REFERENCES geogebra_documents(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;
