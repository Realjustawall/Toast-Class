CREATE TABLE sandbox_boards (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(255) NOT NULL,
  bundle_json LONGTEXT NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX sandbox_boards_classroom_idx (classroom_id, created_at),
  FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;
-- statement
ALTER TABLE classroom_workspace MODIFY COLUMN kind ENUM('document','geogebra','presentation','sandbox') NOT NULL DEFAULT 'document';
-- statement
ALTER TABLE classroom_workspace ADD COLUMN sandbox_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD CONSTRAINT classroom_workspace_sandbox FOREIGN KEY (sandbox_id) REFERENCES sandbox_boards(id) ON DELETE SET NULL;
