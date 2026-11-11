CREATE TABLE platform_admins (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_settings (
  id integer PRIMARY KEY CHECK(id=1),
  registration_open boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO platform_settings(id) VALUES(1);
