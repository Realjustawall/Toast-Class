ALTER TABLE classrooms ADD COLUMN chat_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE collaborative_documents ADD COLUMN board_book_id uuid REFERENCES collaborative_documents(id);
ALTER TABLE collaborative_documents ADD COLUMN board_page_index integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX board_book_page ON collaborative_documents(board_book_id,board_page_index);
