CREATE TABLE board_presenter_views (
 document_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 generation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision INT NOT NULL CHECK(revision>0),
 active BOOLEAN NOT NULL,
 center_x DOUBLE NOT NULL,
 center_y DOUBLE NOT NULL,
 zoom DOUBLE NOT NULL CHECK(zoom>=0.1 AND zoom<=10),
 actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(document_id) REFERENCES collaborative_documents(id),
 FOREIGN KEY(actor_id) REFERENCES users(id),
 CHECK(center_x>=-10000000 AND center_x<=10000000),
 CHECK(center_y>=-10000000 AND center_y<=10000000)
) ENGINE=InnoDB;
