CREATE TABLE board_versions (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 generation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision INT NOT NULL CHECK(revision>=0),
 label VARCHAR(120) NOT NULL,
 kind VARCHAR(16) CHARACTER SET ascii NOT NULL CHECK(kind IN ('manual','automatic','before_restore')),
 state_base64 LONGTEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 author_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(document_id) REFERENCES collaborative_documents(id),
 FOREIGN KEY(author_id) REFERENCES users(id),
 CHECK(CHAR_LENGTH(state_base64)<=4000000),
 INDEX board_versions_document_time(document_id,created_at,id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE board_restore_operations (
 document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 generation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision INT NOT NULL CHECK(revision>0),
 actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(document_id,operation_id),
 FOREIGN KEY(document_id) REFERENCES collaborative_documents(id),
 FOREIGN KEY(actor_id) REFERENCES users(id)
) ENGINE=InnoDB;
