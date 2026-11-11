ALTER TABLE classrooms ADD COLUMN chat_revision BIGINT UNSIGNED NOT NULL DEFAULT 0;
-- statement
ALTER TABLE collaborative_documents
  ADD COLUMN board_book_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN board_page_index INT NOT NULL DEFAULT 1,
  ADD CONSTRAINT fk_board_book FOREIGN KEY (board_book_id) REFERENCES collaborative_documents(id),
  ADD UNIQUE KEY board_book_page (board_book_id, board_page_index);
