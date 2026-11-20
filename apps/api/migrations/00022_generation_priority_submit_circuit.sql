-- +goose Up
ALTER TABLE generation_tasks ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','expedited'));
CREATE INDEX generation_tasks_submit_priority_idx ON generation_tasks(connection_id,(priority='expedited') DESC,created_at,id) WHERE status='queued';

DELETE FROM generation_circuits WHERE operation <> 'submit';
ALTER TABLE generation_circuits DROP CONSTRAINT generation_circuits_operation_check;
ALTER TABLE generation_circuits ADD CONSTRAINT generation_circuits_submit_only CHECK (operation = 'submit');
ALTER TABLE generation_circuits ALTER COLUMN failure_threshold SET DEFAULT 5;
UPDATE generation_circuits SET failure_threshold=5,cooldown_seconds=60 WHERE operation='submit';
ALTER TABLE generation_circuits ADD COLUMN cooldown_step integer NOT NULL DEFAULT 0 CHECK (cooldown_step BETWEEN 0 AND 2);
ALTER TABLE generation_circuits ADD COLUMN last_reason text NOT NULL DEFAULT '';
ALTER TABLE generation_circuits ADD COLUMN next_probe_at timestamptz;

ALTER TABLE generation_admin_audit ADD COLUMN target_type text NOT NULL DEFAULT '';
ALTER TABLE generation_admin_audit ADD COLUMN target_id text NOT NULL DEFAULT '';
ALTER TABLE generation_admin_audit ADD COLUMN change_details jsonb NOT NULL DEFAULT '{}'::jsonb;

-- No destructive down migration for authoritative generation records.
