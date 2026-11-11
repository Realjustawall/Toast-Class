CREATE TABLE classroom_chat_policies (
 classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 public_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 private_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 revision INT UNSIGNED NOT NULL,
 updated_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
 FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;
-- statement
CREATE TABLE private_chat_messages (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 classroom_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 sender_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 recipient_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 client_message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 digest CHAR(64) CHARACTER SET ascii NOT NULL,
 body TEXT NOT NULL,
 deleted BOOLEAN NOT NULL DEFAULT FALSE,
 read_at TIMESTAMP(3) NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY private_send_receipt(classroom_id,sender_id,client_message_id),
 INDEX private_thread_out(classroom_id,sender_id,recipient_id,created_at,id),
 INDEX private_thread_in(classroom_id,recipient_id,sender_id,created_at,id),
 INDEX private_unread(classroom_id,recipient_id,deleted,read_at),
 FOREIGN KEY(classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
 FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
 FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE CASCADE,
 CHECK(sender_id<>recipient_id)
) ENGINE=InnoDB;
