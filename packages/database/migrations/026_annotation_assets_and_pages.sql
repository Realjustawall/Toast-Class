CREATE TABLE board_assets (
 document_id uuid NOT NULL REFERENCES collaborative_documents(id) ON DELETE CASCADE,
 file_id uuid NOT NULL REFERENCES files(id),
 PRIMARY KEY(document_id,file_id)
);
CREATE TABLE annotation_stamps(id uuid PRIMARY KEY,classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,name varchar(80) NOT NULL,elements_json text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE collaborative_documents ADD COLUMN page_archived boolean NOT NULL DEFAULT false;
ALTER TABLE collaborative_documents ADD COLUMN page_bookmark varchar(120) NOT NULL DEFAULT '';
ALTER TABLE collaborative_documents ADD COLUMN page_rotation smallint NOT NULL DEFAULT 0;
ALTER TABLE collaborative_documents ADD COLUMN pdf_source_file_id uuid REFERENCES files(id);
ALTER TABLE collaborative_documents ADD COLUMN pdf_source_page smallint;
CREATE TABLE annotation_stamp_assets(stamp_id uuid NOT NULL REFERENCES annotation_stamps(id) ON DELETE CASCADE,file_id uuid NOT NULL REFERENCES files(id),PRIMARY KEY(stamp_id,file_id));
