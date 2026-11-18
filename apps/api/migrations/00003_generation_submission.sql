-- +goose Up
ALTER TABLE generation_tasks ADD COLUMN connection_id text NOT NULL DEFAULT 'runninghub-international';
ALTER TABLE generation_tasks ADD COLUMN lease_token text;
ALTER TABLE generation_tasks ADD COLUMN lease_until timestamptz;
ALTER TABLE generation_tasks ADD COLUMN provider_task_id text;
ALTER TABLE generation_tasks DROP CONSTRAINT generation_tasks_status_check;
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_status_check CHECK(status IN ('queued','submitting','running','completed','canceled','failed','needs_review'));
CREATE TABLE generation_connection_limits (id text PRIMARY KEY, max_active integer NOT NULL CHECK(max_active > 0));
INSERT INTO generation_connection_limits(id,max_active) VALUES('runninghub-international',5);
CREATE INDEX generation_active_connection_idx ON generation_tasks(connection_id,status) WHERE status IN ('submitting','running','needs_review');
