-- +goose Up
CREATE TABLE script_tasks (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id),
    project_id text NOT NULL,
    node_id text NOT NULL,
    request_id text NOT NULL,
    input jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','running','stopping','stopped','completed','failed','interrupted')),
    phase text NOT NULL DEFAULT 'preparing',
    text text NOT NULL DEFAULT '',
    workflow jsonb,
    output_node_id text,
    error text,
    revision bigint NOT NULL DEFAULT 1,
    lease_id uuid,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(owner_id,request_id),
    FOREIGN KEY(project_id,owner_id) REFERENCES projects(id,owner_id)
);
CREATE UNIQUE INDEX script_tasks_one_active ON script_tasks(project_id,node_id) WHERE status IN ('queued','running','stopping');
CREATE INDEX script_tasks_due ON script_tasks(status,created_at);
CREATE INDEX script_tasks_project ON script_tasks(owner_id,project_id,created_at DESC);
CREATE TABLE script_outbox (
    task_id uuid PRIMARY KEY REFERENCES script_tasks(id),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE script_requests (
    owner_id uuid NOT NULL REFERENCES users(id),
    request_id text NOT NULL,
    task_id uuid NOT NULL REFERENCES script_tasks(id),
    project_id text NOT NULL,
    node_id text NOT NULL,
    input jsonb NOT NULL,
    PRIMARY KEY(owner_id,request_id)
);
-- Retain content and task history for explicit data migration or rollback.
