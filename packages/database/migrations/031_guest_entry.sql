ALTER TABLE users ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE classrooms ADD COLUMN guest_entry_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE classrooms ADD COLUMN guest_max_capacity INTEGER NOT NULL DEFAULT 20;
CREATE TABLE classroom_guests (
 id UUID PRIMARY KEY,
 classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL,
 ip_address TEXT NOT NULL,
 device_id TEXT NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(classroom_id, user_id),
 UNIQUE(classroom_id, ip_address),
 UNIQUE(classroom_id, device_id)
);
CREATE INDEX classroom_guests_room ON classroom_guests(classroom_id, created_at);
