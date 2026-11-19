-- +goose Up
ALTER TABLE agent_tasks ADD COLUMN model_id text NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN question jsonb;
CREATE TABLE agent_messages (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES agent_tasks(id),
    project_id text NOT NULL REFERENCES projects(id),
    role text NOT NULL CHECK (role IN ('user','assistant')),
    text text NOT NULL,
    reference_items jsonb NOT NULL DEFAULT '[]'::jsonb,
    run_id uuid,
    created_at timestamptz NOT NULL
);
CREATE INDEX agent_messages_project_order ON agent_messages(project_id,created_at,id);
CREATE TABLE agent_command_receipts (
    owner_id uuid NOT NULL REFERENCES users(id),
    request_id text NOT NULL,
    digest text NOT NULL,
    task_id uuid NOT NULL REFERENCES agent_tasks(id),
    created_at timestamptz NOT NULL,
    PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE agent_outbox (
    task_id uuid PRIMARY KEY REFERENCES agent_tasks(id),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Agent history is forward-only.
