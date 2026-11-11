CREATE TABLE classroom_chat_policies (
 classroom_id UUID PRIMARY KEY REFERENCES classrooms(id) ON DELETE CASCADE,
 public_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 private_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 revision INTEGER NOT NULL,
 updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE private_chat_messages (
 id UUID PRIMARY KEY,
 classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
 sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 client_message_id UUID NOT NULL,
 digest CHAR(64) NOT NULL,
 body TEXT NOT NULL,
 deleted BOOLEAN NOT NULL DEFAULT FALSE,
 read_at TIMESTAMP NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(classroom_id,sender_id,client_message_id),
 CHECK(sender_id<>recipient_id)
);
CREATE INDEX private_thread_out ON private_chat_messages(classroom_id,sender_id,recipient_id,created_at,id);
CREATE INDEX private_thread_in ON private_chat_messages(classroom_id,recipient_id,sender_id,created_at,id);
CREATE INDEX private_unread ON private_chat_messages(classroom_id,recipient_id,deleted,read_at);
