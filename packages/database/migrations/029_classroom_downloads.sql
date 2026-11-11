CREATE TABLE classroom_download_policies (
 classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
 target_kind VARCHAR(16) NOT NULL CHECK(target_kind IN ('file','board','presentation')),
 target_id UUID NOT NULL,
 enabled BOOLEAN NOT NULL,
 revision INTEGER NOT NULL,
 updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(classroom_id,target_kind,target_id)
);
