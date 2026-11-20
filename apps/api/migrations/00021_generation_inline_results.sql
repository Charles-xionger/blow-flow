-- +goose Up
CREATE TABLE generation_inline_results (
 task_id text PRIMARY KEY REFERENCES generation_tasks(id) ON DELETE CASCADE,
 file_type text NOT NULL CHECK (file_type IN ('png','jpeg')),
 body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 52428800),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- The inline result is deleted only after durable OSS delivery.
