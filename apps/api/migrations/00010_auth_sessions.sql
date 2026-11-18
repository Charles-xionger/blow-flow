-- +goose Up
CREATE TABLE auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issuer text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    authenticated_at timestamptz NOT NULL,
    secret_hash bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL,
    rotated_at timestamptz
);
CREATE INDEX auth_sessions_user_active ON auth_sessions(user_id) WHERE revoked_at IS NULL;

-- Account session history is forward-only. Restore from backup for rollback.
