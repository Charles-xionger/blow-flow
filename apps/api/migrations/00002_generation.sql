-- +goose Up
CREATE TABLE generation_resource_grants (
 owner_id uuid NOT NULL REFERENCES users(id),
 resource_type text NOT NULL CHECK(resource_type IN ('project','reference')),
 resource_id text NOT NULL,
 PRIMARY KEY(owner_id,resource_type,resource_id)
);
CREATE TABLE generation_tasks (
 id text PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES users(id),
 project_id text NOT NULL,
 model text NOT NULL,
 input_snapshot jsonb NOT NULL,
 input_hash text NOT NULL,
 idempotency_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','completed','canceled','failed','needs_review')),
 result_url text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(owner_id,idempotency_key)
);
CREATE TABLE generation_task_events (
 id bigserial PRIMARY KEY,
 task_id text NOT NULL REFERENCES generation_tasks(id),
 event_type text NOT NULL,
 occurred_at timestamptz NOT NULL
);
CREATE TABLE generation_outbox (
 id bigserial PRIMARY KEY,
 task_id text NOT NULL REFERENCES generation_tasks(id),
 published_at timestamptz,
 created_at timestamptz NOT NULL
);
CREATE INDEX generation_outbox_pending_idx ON generation_outbox(id) WHERE published_at IS NULL;
-- Generation tasks are authoritative and this migration has no destructive down path.
