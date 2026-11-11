CREATE TABLE chat_categories (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(60) NOT NULL,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
  FOREIGN KEY(created_by) REFERENCES users(id),
  UNIQUE(classroom_id,name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- statement
ALTER TABLE messages ADD COLUMN category_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD CONSTRAINT messages_chat_category FOREIGN KEY(category_id) REFERENCES chat_categories(id) ON DELETE SET NULL,
  ADD INDEX messages_category_time(classroom_id,category_id,created_at);
