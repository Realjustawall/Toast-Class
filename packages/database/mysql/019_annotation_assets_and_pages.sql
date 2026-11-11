CREATE TABLE board_assets (
  document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY(document_id,file_id),
  FOREIGN KEY(document_id) REFERENCES collaborative_documents(id) ON DELETE CASCADE,
  FOREIGN KEY(file_id) REFERENCES files(id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE annotation_stamps (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 name VARCHAR(80) NOT NULL,
 elements_json LONGTEXT NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
 INDEX annotation_stamp_owner(classroom_id,user_id)
) ENGINE=InnoDB;
-- statement
ALTER TABLE collaborative_documents
  ADD COLUMN page_archived BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN page_bookmark VARCHAR(120) NOT NULL DEFAULT '',
  ADD COLUMN page_rotation SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN pdf_source_file_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN pdf_source_page SMALLINT NULL,
  ADD CONSTRAINT annotation_pdf_source FOREIGN KEY(pdf_source_file_id) REFERENCES files(id);
-- statement
CREATE TABLE annotation_stamp_assets (
 stamp_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 file_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY(stamp_id,file_id),
 FOREIGN KEY(stamp_id) REFERENCES annotation_stamps(id) ON DELETE CASCADE,
 FOREIGN KEY(file_id) REFERENCES files(id)
) ENGINE=InnoDB;
