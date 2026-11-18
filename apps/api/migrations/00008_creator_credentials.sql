-- +goose Up
CREATE TABLE creator_credentials (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
-- Local creator accounts are provisioned as verified by a trusted CLI. Public
-- registration and email verification require an outbound mail integration.
-- No destructive down migration for credentials.
