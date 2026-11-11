ALTER TABLE classroom_user_permissions ADD COLUMN can_chat_images boolean;
ALTER TABLE classroom_user_permissions ADD COLUMN interaction_locked boolean NOT NULL DEFAULT false;
ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK(purpose IN ('resource','presentation','chat'));
ALTER TABLE messages ADD COLUMN image_file_id uuid REFERENCES files(id) ON DELETE SET NULL;
CREATE INDEX messages_image ON messages(image_file_id);
