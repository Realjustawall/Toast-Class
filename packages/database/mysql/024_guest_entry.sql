ALTER TABLE users ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT FALSE;
-- statement
ALTER TABLE classrooms ADD COLUMN guest_entry_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- statement
ALTER TABLE classrooms ADD COLUMN guest_max_capacity INT UNSIGNED NOT NULL DEFAULT 20;
-- statement
CREATE TABLE classroom_guests (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 display_name VARCHAR(120) CHARACTER SET utf8mb4 NOT NULL,
 ip_address VARCHAR(128) CHARACTER SET ascii NOT NULL,
 device_id VARCHAR(128) CHARACTER SET ascii NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY guest_user(classroom_id, user_id),
 UNIQUE KEY guest_ip(classroom_id, ip_address),
 UNIQUE KEY guest_device(classroom_id, device_id),
 INDEX classroom_guests_room(classroom_id, created_at),
 FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
