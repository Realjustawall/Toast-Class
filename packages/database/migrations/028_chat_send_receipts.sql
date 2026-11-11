CREATE TABLE chat_send_receipts (
 classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 client_message_id UUID NOT NULL,
 message_id UUID NOT NULL,
 digest CHAR(64) NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(classroom_id,user_id,client_message_id)
);
CREATE INDEX chat_receipt_expiry ON chat_send_receipts(classroom_id,user_id,created_at);
