CREATE TABLE organizations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  storage_quota_bytes BIGINT NOT NULL DEFAULT 1073741824,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CHECK(storage_quota_bytes>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- statement
CREATE TABLE memberships (
  organization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role ENUM('owner','teacher','student') NOT NULL,
  PRIMARY KEY(organization_id,user_id),
  FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX memberships_user(user_id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE classrooms (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  organization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(organization_id) REFERENCES organizations(id),
  FOREIGN KEY(created_by) REFERENCES users(id),
  UNIQUE(id,organization_id), INDEX classrooms_org(organization_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- statement
CREATE TABLE messages (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id), FOREIGN KEY(user_id) REFERENCES users(id),
  INDEX messages_room_time(classroom_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- statement
CREATE TABLE audit_logs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  organization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  action VARCHAR(120) CHARACTER SET ascii NOT NULL,
  resource_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  actor_kind ENUM('user','system') NOT NULL DEFAULT 'user',
  details JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(actor_id) REFERENCES users(id), FOREIGN KEY(organization_id) REFERENCES organizations(id),
  CHECK(actor_kind='system' OR actor_id IS NOT NULL),
  INDEX audit_org_time(organization_id,created_at DESC,id DESC),
  INDEX audit_org_action_time(organization_id,action,created_at DESC,id DESC)
) ENGINE=InnoDB;
-- statement
CREATE TABLE classroom_sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ended_at DATETIME(3),
  active_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id), FOREIGN KEY(started_by) REFERENCES users(id),
  FOREIGN KEY(active_key) REFERENCES classrooms(id),
  CHECK(active_key IS NULL OR active_key=classroom_id), UNIQUE(id,classroom_id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE media_webhook_events (
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  body_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  event_type VARCHAR(100) CHARACTER SET ascii NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
-- statement
CREATE TABLE media_connections (
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  joined_at DATETIME(3), left_at DATETIME(3),
  FOREIGN KEY(classroom_id) REFERENCES classrooms(id), FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(session_id) REFERENCES classroom_sessions(id), INDEX media_connections_room(classroom_id,user_id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE media_permissions (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  microphone BOOLEAN NOT NULL DEFAULT TRUE, camera BOOLEAN NOT NULL DEFAULT TRUE,
  screen_share BOOLEAN NOT NULL DEFAULT TRUE, blocked BOOLEAN NOT NULL DEFAULT FALSE,
  version INT NOT NULL DEFAULT 1, PRIMARY KEY(session_id,user_id),
  FOREIGN KEY(session_id) REFERENCES classroom_sessions(id), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE media_commands (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  kind ENUM('permissions','remove','delete_room') NOT NULL, payload JSON NOT NULL,
  status ENUM('pending','succeeded','failed') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0, next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error TEXT, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), completed_at DATETIME(3),
  FOREIGN KEY(session_id) REFERENCES classroom_sessions(id), FOREIGN KEY(user_id) REFERENCES users(id),
  INDEX media_commands_pending(status,next_attempt_at)
) ENGINE=InnoDB;
