CREATE TABLE hand_raises (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  raised_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(session_id,user_id),
  FOREIGN KEY(session_id) REFERENCES classroom_sessions(id), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE classroom_timers (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  duration_seconds INT NOT NULL, remaining_ms INT NOT NULL, deadline DATETIME(3),
  status ENUM('running','paused','stopped') NOT NULL,
  FOREIGN KEY(session_id) REFERENCES classroom_sessions(id), CHECK(duration_seconds BETWEEN 1 AND 86400)
) ENGINE=InnoDB;
-- statement
CREATE TABLE polls (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question TEXT NOT NULL, options JSON NOT NULL, status ENUM('draft','open','paused','ended') NOT NULL,
  results_published BOOLEAN NOT NULL DEFAULT FALSE, closes_at DATETIME(3),
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(session_id) REFERENCES classroom_sessions(id), FOREIGN KEY(created_by) REFERENCES users(id),
  INDEX polls_session(session_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- statement
CREATE TABLE poll_responses (
  poll_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  choice INT NOT NULL, submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(poll_id,user_id), FOREIGN KEY(poll_id) REFERENCES polls(id), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE collaborative_documents (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('notes','board') NOT NULL, name VARCHAR(120) NOT NULL,
  teacher_only BOOLEAN NOT NULL DEFAULT FALSE,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  source_document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  board_format ENUM('legacy','excalidraw') NOT NULL DEFAULT 'legacy',
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id), FOREIGN KEY(created_by) REFERENCES users(id),
  FOREIGN KEY(source_document_id) REFERENCES collaborative_documents(id),
  CHECK(kind='board' OR board_format='legacy')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- statement
CREATE TABLE document_updates (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  author_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_base64 LONGTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(document_id) REFERENCES collaborative_documents(id), FOREIGN KEY(author_id) REFERENCES users(id),
  INDEX document_updates_doc(document_id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE board_states (
  document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  generation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  state_base64 LONGTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT (''),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(document_id) REFERENCES collaborative_documents(id), CHECK(revision>=0),
  CHECK(CHAR_LENGTH(state_base64)<=4000000)
) ENGINE=InnoDB;
-- statement
CREATE TABLE board_receipts (
  document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT NOT NULL CHECK(revision>0), digest CHAR(64) CHARACTER SET ascii NOT NULL,
  update_base64 LONGTEXT CHARACTER SET ascii COLLATE ascii_bin,
  author_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(document_id,update_id), UNIQUE(document_id,revision),
  FOREIGN KEY(document_id) REFERENCES collaborative_documents(id), FOREIGN KEY(author_id) REFERENCES users(id)
) ENGINE=InnoDB;
