ALTER TABLE organizations ADD COLUMN default_classroom_theme VARCHAR(32) NOT NULL DEFAULT 'classic-bbb';
-- statement
ALTER TABLE classrooms ADD COLUMN theme VARCHAR(32) NOT NULL DEFAULT 'classic-bbb';
-- statement
ALTER TABLE classrooms ADD COLUMN chat_enabled BOOLEAN NOT NULL DEFAULT TRUE;
-- statement
ALTER TABLE classrooms ADD COLUMN hand_raise_enabled BOOLEAN NOT NULL DEFAULT TRUE;
-- statement
ALTER TABLE classrooms ADD COLUMN student_whiteboard_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- statement
ALTER TABLE classrooms ADD COLUMN default_microphone BOOLEAN NOT NULL DEFAULT TRUE;
-- statement
ALTER TABLE classrooms ADD COLUMN default_camera BOOLEAN NOT NULL DEFAULT TRUE;
-- statement
ALTER TABLE classrooms ADD COLUMN default_screen_share BOOLEAN NOT NULL DEFAULT TRUE;
-- statement
ALTER TABLE classrooms ADD COLUMN locked BOOLEAN NOT NULL DEFAULT FALSE;
