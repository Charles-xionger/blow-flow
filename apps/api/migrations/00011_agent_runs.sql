-- +goose Up
CREATE TABLE agent_tasks (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id),
    project_id text NOT NULL REFERENCES projects(id),
    request_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','running','waiting','completed','failed','stopped','interrupted')),
    run_id uuid,
    run_hash bytea,
    lease_until timestamptz,
    editable_node_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    delete_grants jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE(owner_id,request_id)
);
CREATE UNIQUE INDEX agent_one_active_project ON agent_tasks(project_id)
    WHERE status IN ('queued','running','waiting','interrupted');
CREATE TABLE agent_task_events (
    id bigserial PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES agent_tasks(id),
    kind text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL
);
CREATE INDEX agent_task_events_cursor ON agent_task_events(task_id,id);
CREATE TABLE agent_canvas_receipts (
    task_id uuid NOT NULL REFERENCES agent_tasks(id),
    call_id text NOT NULL,
    digest text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY(task_id,call_id)
);

-- Agent task and receipt history is forward-only.
