-- +goose Up
ALTER TABLE generation_tasks DROP CONSTRAINT generation_tasks_status_check;
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_status_check CHECK(status IN ('queued','submitting','running','saving','save_failed','save_unavailable','wait_timeout','completed','canceled','failed','needs_review'));
ALTER TABLE generation_tasks ADD COLUMN stage text NOT NULL DEFAULT 'queued';
ALTER TABLE generation_tasks ADD COLUMN percent double precision CHECK(percent >= 0 AND percent <= 100);
ALTER TABLE generation_tasks ADD COLUMN provider_result_url text;
ALTER TABLE generation_tasks ADD COLUMN provider_result_type text;
ALTER TABLE generation_tasks ADD COLUMN failure_code text;
ALTER TABLE generation_tasks ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE generation_tasks ADD COLUMN poll_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE generation_tasks ADD COLUMN tracking_started_at timestamptz;
CREATE INDEX generation_tracking_due_idx ON generation_tasks(next_attempt_at) WHERE status IN ('running','saving','save_failed');
DROP INDEX generation_active_connection_idx;
CREATE INDEX generation_active_connection_idx ON generation_tasks(connection_id,status) WHERE status IN ('submitting','running','wait_timeout','needs_review');
