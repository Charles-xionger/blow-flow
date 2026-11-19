-- +goose Up
ALTER TABLE agent_tasks ADD COLUMN claimed_user_count bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_messages ADD COLUMN call_id text;
CREATE UNIQUE INDEX agent_messages_call ON agent_messages(task_id,call_id) WHERE call_id IS NOT NULL;
CREATE TABLE agent_tool_steps (
    task_id uuid NOT NULL REFERENCES agent_tasks(id),
    call_id text NOT NULL,
    run_id uuid NOT NULL,
    name text NOT NULL,
    arguments jsonb NOT NULL,
    digest text NOT NULL,
    status text NOT NULL CHECK (status IN ('running','completed','failed')),
    result jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY(task_id,call_id)
);
CREATE INDEX agent_tool_steps_task_order ON agent_tool_steps(task_id,created_at,call_id);

-- Runner history is forward-only.
