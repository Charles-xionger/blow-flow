-- +goose Up
CREATE TABLE user_skills (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, name)
);
CREATE TABLE user_skill_resources (
  owner_id uuid NOT NULL,
  skill_name text NOT NULL,
  path text NOT NULL,
  content bytea NOT NULL,
  PRIMARY KEY (owner_id, skill_name, path),
  FOREIGN KEY (owner_id, skill_name) REFERENCES user_skills(owner_id, name) ON DELETE CASCADE
);

-- This migration is intentionally irreversible.
