-- +goose Up
ALTER TABLE generation_tasks ADD COLUMN provider_usage jsonb;
ALTER TABLE generation_admin_audit ADD COLUMN task_id text;
