CREATE TABLE presentations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  organization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_file_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(200) NOT NULL,
  status ENUM('queued','processing','scanning','ready','failed','deleting','deleted') NOT NULL,
  generation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claim CHAR(36) CHARACTER SET ascii COLLATE ascii_bin, claimed_until DATETIME(3),
  reserved_bytes BIGINT NOT NULL DEFAULT 0, page_count INT, attempts INT NOT NULL DEFAULT 0,
  failure_code VARCHAR(100) CHARACTER SET ascii,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE(id,organization_id), UNIQUE(id,classroom_id),
  FOREIGN KEY(organization_id) REFERENCES organizations(id), FOREIGN KEY(classroom_id) REFERENCES classrooms(id),
  FOREIGN KEY(source_file_id) REFERENCES files(id), FOREIGN KEY(created_by) REFERENCES users(id),
  FOREIGN KEY(classroom_id,organization_id) REFERENCES classrooms(id,organization_id),
  FOREIGN KEY(source_file_id,organization_id) REFERENCES files(id,organization_id),
  CHECK(CHAR_LENGTH(name) BETWEEN 1 AND 200), CHECK(reserved_bytes>=0), CHECK(attempts>=0),
  CHECK(page_count IS NULL OR page_count BETWEEN 1 AND 200),
  CHECK((status='processing' AND claim IS NOT NULL AND claimed_until IS NOT NULL) OR
        (status<>'processing' AND claim IS NULL AND claimed_until IS NULL)),
  CHECK(status NOT IN ('scanning','ready') OR page_count IS NOT NULL),
  CHECK(status<>'queued' OR reserved_bytes>0),
  INDEX presentations_jobs(status,created_at), INDEX presentations_room(classroom_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- statement
CREATE TABLE presentation_assets (
  presentation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  organization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  generation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  page_number INT NOT NULL, width INT, height INT,
  PRIMARY KEY(presentation_id,generation,page_number),
  FOREIGN KEY(presentation_id) REFERENCES presentations(id), FOREIGN KEY(organization_id) REFERENCES organizations(id),
  FOREIGN KEY(file_id) REFERENCES files(id),
  FOREIGN KEY(presentation_id,organization_id) REFERENCES presentations(id,organization_id),
  FOREIGN KEY(file_id,organization_id) REFERENCES files(id,organization_id),
  CHECK(page_number BETWEEN 0 AND 200),
  CHECK((page_number=0 AND width IS NULL AND height IS NULL) OR
        (page_number>0 AND width IS NOT NULL AND height IS NOT NULL AND width BETWEEN 1 AND 1600 AND height BETWEEN 1 AND 1600))
) ENGINE=InnoDB;
-- statement
CREATE TABLE session_presentations (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  presentation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  page_number INT, independent_view BOOLEAN NOT NULL DEFAULT FALSE,
  revision INT NOT NULL DEFAULT 1, changed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY(session_id) REFERENCES classroom_sessions(id), FOREIGN KEY(classroom_id) REFERENCES classrooms(id),
  FOREIGN KEY(presentation_id) REFERENCES presentations(id), FOREIGN KEY(changed_by) REFERENCES users(id),
  FOREIGN KEY(session_id,classroom_id) REFERENCES classroom_sessions(id,classroom_id),
  FOREIGN KEY(presentation_id,classroom_id) REFERENCES presentations(id,classroom_id),
  CHECK(page_number IS NULL OR page_number BETWEEN 1 AND 200), CHECK(revision>0),
  CHECK((presentation_id IS NULL)=(page_number IS NULL))
) ENGINE=InnoDB;
