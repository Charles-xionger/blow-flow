-- +goose Up
ALTER TABLE generation_tasks ADD COLUMN node_id text NOT NULL DEFAULT '';
ALTER TABLE generation_tasks ADD COLUMN save_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE generation_tasks ADD COLUMN recovery_checked_at timestamptz;
ALTER TABLE generation_tasks DROP CONSTRAINT generation_tasks_status_check;
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_status_check CHECK(status IN ('queued','submitting','running','saving','save_failed','save_unavailable','save_exhausted','query_failed','wait_timeout','completed','canceled','failed','needs_review'));

-- The head records the latest task requested for a node. Old tasks retain their
-- own result, but may only change this projection while they are the head.
CREATE TABLE generation_node_results (
 owner_id uuid NOT NULL REFERENCES users(id),
 project_id text NOT NULL,
 node_id text NOT NULL,
 task_id text NOT NULL REFERENCES generation_tasks(id),
 result_url text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,project_id,node_id)
);
CREATE INDEX generation_queued_recovery_idx ON generation_tasks(recovery_checked_at,created_at,id) WHERE status='queued';
CREATE INDEX generation_tracking_due_v2_idx ON generation_tasks(next_attempt_at) WHERE status IN ('running','saving','save_failed');
