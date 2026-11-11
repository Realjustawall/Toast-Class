ALTER TABLE files DROP CONSTRAINT files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check CHECK(purpose IN ('resource','presentation','chat','board'));
ALTER TABLE collaborative_documents ADD COLUMN background_file_id uuid REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE collaborative_documents ADD COLUMN background_width integer;
ALTER TABLE collaborative_documents ADD COLUMN background_height integer;
