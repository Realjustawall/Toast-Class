CREATE TABLE breakout_groups (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  parent_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  active_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  status ENUM('active','closed') NOT NULL, ends_at DATETIME(3) NOT NULL,
  allow_self_select BOOLEAN NOT NULL DEFAULT FALSE,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), closed_at DATETIME(3),
  FOREIGN KEY(parent_session_id) REFERENCES classroom_sessions(id), FOREIGN KEY(active_key) REFERENCES classroom_sessions(id),
  FOREIGN KEY(created_by) REFERENCES users(id), CHECK(active_key IS NULL OR active_key=parent_session_id),
  INDEX breakout_groups_expiry(status,ends_at)
) ENGINE=InnoDB;
-- statement
CREATE TABLE breakout_rooms (
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  position INT NOT NULL, UNIQUE(group_id,position), UNIQUE(group_id,classroom_id),
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id), FOREIGN KEY(group_id) REFERENCES breakout_groups(id),
  FOREIGN KEY(session_id) REFERENCES classroom_sessions(id), INDEX breakout_rooms_group(group_id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE breakout_assignments (
  group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  room_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  revision INT NOT NULL DEFAULT 1, assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(group_id,user_id), FOREIGN KEY(group_id) REFERENCES breakout_groups(id), FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(room_id) REFERENCES breakout_rooms(classroom_id),
  FOREIGN KEY(group_id,room_id) REFERENCES breakout_rooms(group_id,classroom_id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE breakout_assignment_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  room_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin, revision INT NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(group_id,user_id,revision),
  FOREIGN KEY(group_id) REFERENCES breakout_groups(id), FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(room_id) REFERENCES breakout_rooms(classroom_id), FOREIGN KEY(actor_id) REFERENCES users(id),
  FOREIGN KEY(group_id,room_id) REFERENCES breakout_rooms(group_id,classroom_id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE breakout_announcements (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body TEXT NOT NULL, sent_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(group_id) REFERENCES breakout_groups(id), FOREIGN KEY(sent_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
