CREATE TABLE chat_categories (
  id uuid PRIMARY KEY,
  classroom_id uuid NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(classroom_id,name)
);
ALTER TABLE messages ADD COLUMN category_id uuid REFERENCES chat_categories(id) ON DELETE SET NULL;
CREATE INDEX messages_category_time ON messages(classroom_id,category_id,created_at);
