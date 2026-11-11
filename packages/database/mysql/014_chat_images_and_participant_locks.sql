ALTER TABLE classroom_user_permissions
  ADD COLUMN can_chat_images BOOLEAN NULL,
  ADD COLUMN interaction_locked BOOLEAN NOT NULL DEFAULT FALSE;
-- statement
ALTER TABLE files MODIFY COLUMN purpose ENUM('resource','presentation','chat') NOT NULL DEFAULT 'resource';
-- statement
ALTER TABLE messages ADD COLUMN image_file_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD CONSTRAINT messages_image_file FOREIGN KEY(image_file_id) REFERENCES files(id) ON DELETE SET NULL,
  ADD INDEX messages_image(image_file_id);
