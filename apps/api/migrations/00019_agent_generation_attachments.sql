-- +goose Up
CREATE TABLE agent_generation_attachments (
    task_id text PRIMARY KEY REFERENCES generation_tasks(id),
    node_id text NOT NULL,
    note text NOT NULL,
    attached_at timestamptz NOT NULL
);
ALTER TABLE agent_generation_batches ADD COLUMN bindings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_generation_batches ADD COLUMN model_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE agent_generation_submission_bindings (
    task_id text PRIMARY KEY REFERENCES generation_tasks(id),
    node_id text NOT NULL,
    digest text NOT NULL
);

-- +goose Down
DROP TABLE agent_generation_attachments;
DROP TABLE agent_generation_submission_bindings;
ALTER TABLE agent_generation_batches DROP COLUMN bindings;
ALTER TABLE agent_generation_batches DROP COLUMN model_snapshots;
