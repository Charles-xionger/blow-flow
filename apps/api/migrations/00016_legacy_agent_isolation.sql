-- +goose Up
ALTER TABLE agent_tasks ADD COLUMN legacy_imported boolean NOT NULL DEFAULT false;
DROP INDEX agent_one_active_project;
CREATE UNIQUE INDEX agent_one_active_project ON agent_tasks(project_id)
    WHERE status IN ('queued','running','waiting','interrupted') AND NOT legacy_imported;

CREATE TABLE agent_legacy_command_receipts (
    project_id text NOT NULL REFERENCES projects(id),
    request_id text NOT NULL,
    digest text NOT NULL,
    task_id uuid NOT NULL REFERENCES agent_tasks(id),
    PRIMARY KEY(project_id,request_id)
);
CREATE TABLE agent_legacy_canvas_receipts (
    project_id text NOT NULL REFERENCES projects(id),
    identity text NOT NULL,
    digest text NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY(project_id,identity)
);

-- Legacy records stay read-only and cannot be claimed as Go work.
