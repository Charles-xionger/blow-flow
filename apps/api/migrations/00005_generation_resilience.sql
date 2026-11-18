-- +goose Up
CREATE TABLE generation_queue_limits (
 scope text NOT NULL CHECK (scope IN ('user','model','connection')),
 key text NOT NULL,
 max_active integer NOT NULL CHECK (max_active > 0),
 max_queued integer NOT NULL CHECK (max_queued > 0),
 PRIMARY KEY(scope,key)
);
INSERT INTO generation_queue_limits VALUES
 ('user','*',5,100),('model','runninghub/krea2',5,100),('connection','runninghub-international',5,100);
CREATE TABLE generation_circuits (
 connection_id text NOT NULL,
 operation text NOT NULL CHECK (operation IN ('submit','query','save')),
 state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
 consecutive_failures integer NOT NULL DEFAULT 0,
 failure_threshold integer NOT NULL DEFAULT 3 CHECK (failure_threshold > 0),
 cooldown_seconds integer NOT NULL DEFAULT 30 CHECK (cooldown_seconds > 0),
 opened_at timestamptz,
 probe_until timestamptz,
 probe_task_id text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(connection_id,operation)
);
INSERT INTO generation_circuits(connection_id,operation) VALUES
 ('runninghub-international','submit'),('runninghub-international','query'),('runninghub-international','save');
CREATE TABLE generation_worker_heartbeats (
 worker_id text PRIMARY KEY,
 seen_at timestamptz NOT NULL
);
CREATE TABLE generation_circuit_events (
 id bigserial PRIMARY KEY,
 connection_id text NOT NULL,
 operation text NOT NULL,
 state text NOT NULL,
 reason text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE generation_admin_audit (
 id bigserial PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES users(id),
 action text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generation_tasks_queued_scope_idx ON generation_tasks(owner_id,model,connection_id) WHERE status='queued';
-- No destructive down migration for authoritative generation records.
