CREATE TABLE classroom_download_policies (
 classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 target_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 target_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 enabled BOOLEAN NOT NULL,
 revision INT UNSIGNED NOT NULL,
 updated_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(classroom_id,target_kind,target_id),
 FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
 FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL,
 CHECK(target_kind IN ('file','board','presentation'))
) ENGINE=InnoDB;
