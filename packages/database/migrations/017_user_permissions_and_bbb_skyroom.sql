CREATE TABLE classroom_user_permissions (
  classroom_id uuid NOT NULL REFERENCES classrooms(id),
  user_id uuid NOT NULL REFERENCES users(id),
  can_chat boolean,
  can_whiteboard boolean,
  can_microphone boolean,
  can_camera boolean,
  can_screen_share boolean,
  can_raise_hand boolean,
  is_presenter boolean NOT NULL DEFAULT false,
  kicked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (classroom_id, user_id)
);

CREATE TABLE classroom_participant_statuses (
  classroom_id uuid NOT NULL REFERENCES classrooms(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'none',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (classroom_id, user_id)
);

ALTER TABLE classrooms ADD COLUMN pinned_notice text NOT NULL DEFAULT '';
ALTER TABLE classrooms ADD COLUMN external_media_url text NOT NULL DEFAULT '';
