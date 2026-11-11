ALTER TABLE organizations ADD COLUMN storage_quota_bytes bigint NOT NULL DEFAULT 1073741824 CHECK(storage_quota_bytes>0);
ALTER TABLE classrooms ADD CONSTRAINT classroom_organization_pair UNIQUE(id,organization_id);
CREATE TABLE file_folders (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 classroom_id uuid REFERENCES classrooms(id), parent_id uuid REFERENCES file_folders(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200), created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id),
 FOREIGN KEY(classroom_id,organization_id) REFERENCES classrooms(id,organization_id),
 FOREIGN KEY(parent_id,organization_id) REFERENCES file_folders(id,organization_id), CHECK(parent_id IS NULL OR parent_id<>id)
);
CREATE INDEX file_folders_scope ON file_folders(organization_id,classroom_id,parent_id);
CREATE TABLE files (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), classroom_id uuid REFERENCES classrooms(id),
 folder_id uuid REFERENCES file_folders(id), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 original_name text NOT NULL, object_key uuid UNIQUE NOT NULL,
 byte_size bigint NOT NULL CHECK(byte_size>0), sha256 text, media_type text,
 status text NOT NULL CHECK(status IN ('uploading','quarantined','ready','rejected','failed','deleting','deleted')),
 scan_status text NOT NULL CHECK(scan_status IN ('pending','clean','infected','unscanned','error')),
 failure_code text, uploaded_by uuid NOT NULL REFERENCES users(id),
 source_file_id uuid REFERENCES files(id), delete_reason text CHECK(delete_reason IN ('user','infected','upload_failed','upload_expired')),
 cleanup_attempts integer NOT NULL DEFAULT 0 CHECK(cleanup_attempts>=0), next_cleanup_at timestamptz NOT NULL DEFAULT now(),
 scan_attempts integer NOT NULL DEFAULT 0 CHECK(scan_attempts>=0),
 next_scan_at timestamptz NOT NULL DEFAULT now(), scan_claim uuid, scan_claimed_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(classroom_id,organization_id) REFERENCES classrooms(id,organization_id),
 FOREIGN KEY(folder_id,organization_id) REFERENCES file_folders(id,organization_id),
 CHECK(sha256 IS NULL OR length(sha256)=64)
);
CREATE INDEX files_scope ON files(organization_id,classroom_id,folder_id,created_at,id);
CREATE INDEX files_cleanup ON files(status,updated_at);
