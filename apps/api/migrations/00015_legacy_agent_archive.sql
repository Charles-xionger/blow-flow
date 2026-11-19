-- +goose Up
CREATE TABLE agent_legacy_generation_batches (
    id text PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES agent_tasks(id),
    data jsonb NOT NULL
);
CREATE TABLE agent_legacy_task_snapshots (
    task_id uuid PRIMARY KEY REFERENCES agent_tasks(id),
    data jsonb NOT NULL
);

-- Legacy provider requests are historical records and must never be resubmitted.
