ALTER TABLE files MODIFY COLUMN purpose ENUM('resource','presentation','chat','board') NOT NULL DEFAULT 'resource';
-- statement
ALTER TABLE collaborative_documents
  ADD COLUMN background_file_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN background_width INT NULL,
  ADD COLUMN background_height INT NULL,
  ADD CONSTRAINT board_background_file FOREIGN KEY(background_file_id) REFERENCES files(id) ON DELETE SET NULL;
