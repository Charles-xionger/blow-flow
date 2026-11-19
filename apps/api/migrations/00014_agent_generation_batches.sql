-- +goose Up
CREATE TABLE agent_generation_batches (
    id text PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES agent_tasks(id),
    digest text NOT NULL,
    canvas_version bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','approved','cancelled')),
    items jsonb NOT NULL,
    generation_task_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX agent_generation_batches_task ON agent_generation_batches(task_id,created_at);

-- Generation approval history is forward-only.
