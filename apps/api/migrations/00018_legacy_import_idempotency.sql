-- +goose Up
CREATE TABLE legacy_import_runs (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  export_digest text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- This migration is intentionally irreversible.
