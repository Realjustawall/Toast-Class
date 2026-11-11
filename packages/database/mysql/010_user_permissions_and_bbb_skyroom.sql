CREATE TABLE classroom_user_permissions (
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  can_chat BOOLEAN NULL,
  can_whiteboard BOOLEAN NULL,
  can_microphone BOOLEAN NULL,
  can_camera BOOLEAN NULL,
  can_screen_share BOOLEAN NULL,
  can_raise_hand BOOLEAN NULL,
  is_presenter BOOLEAN NOT NULL DEFAULT FALSE,
  kicked BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (classroom_id, user_id),
  CONSTRAINT fk_cup_classroom FOREIGN KEY (classroom_id) REFERENCES classrooms(id),
  CONSTRAINT fk_cup_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
-- statement
CREATE TABLE classroom_participant_statuses (
  classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'none',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (classroom_id, user_id),
  CONSTRAINT fk_cps_classroom FOREIGN KEY (classroom_id) REFERENCES classrooms(id),
  CONSTRAINT fk_cps_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
-- statement
ALTER TABLE classrooms ADD COLUMN pinned_notice VARCHAR(1000) NOT NULL DEFAULT '';
-- statement
ALTER TABLE classrooms ADD COLUMN external_media_url VARCHAR(1000) NOT NULL DEFAULT '';
