# Repository and runtime foundation

## Phase 1 boundary

Turborepo coordinates pnpm workspaces and task ordering. Go modules own Go
dependencies; the apps/api package scripts expose Go commands to Turbo.
Existing Web business code and all three legacy workers remain together in
apps/web. Extraction follows domain migration rather than copying internal code.

packages/evals currently consumes one explicit public export from apps/web:
storyboard-validation. This temporary dependency executes the real production
validator; replace it with a shared domain package when that module moves.
It must not import database or Next.js runtime internals.

Production storage target: PostgreSQL + GORM in Go, reviewed Goose SQL migrations.
No GORM AutoMigrate in API startup. Exactly one deployment migration job owns DDL.
No business tables are added in the foundation; the integration suite exercises
migration application and repeatability with fixture SQL in a temporary schema.

Existing ADR 0002/0003 describe SQLite-based workers and notifications. Those
remain the behavior of the legacy application during migration. ADR-0021 and
the Go generation migration design specify PostgreSQL, RabbitMQ and Redis for
the generation domain after cutover; preserve approval, idempotency, lease
fencing and saved-result semantics.

## Migration invariants

- Preserve project/node/task IDs, history, media URLs and deletion tombstones.
- Freeze old writes for data cutover; export, import, verify counts and relations,
  then switch traffic. Prepare backup and an explicit rollback window.
- Migrate complete transaction boundaries, e.g. approval + generation task creation.
- One authoritative writer per domain. Do not let Go and TypeScript independently
  apply migrations or mutate the same business tables without an agreed protocol.
- HTTP and event contracts are language-neutral. Add OpenAPI schemas and generated
  clients alongside the first migrated business endpoint.
- A queue notification carries identifiers; durable state stays in PostgreSQL.
  Add transactional outbox and idempotent consumers when MQ is introduced.
- Existing provider task IDs must never be resubmitted as part of deployment/recovery.

## Test layers

1. Go unit/HTTP handler tests: live/ready distinction, request IDs, sanitized Sentry
   transport. Web unit/service tests retain business and persistence coverage.
2. PostgreSQL integration: real DB, isolated schema, Goose repeat application,
   JSONB writes, uniqueness, transaction rollback and readiness failure.
3. Process E2E: compile binary, bind ephemeral port, real HTTP and SIGTERM shutdown.
4. Canvas E2E: real Next.js/worker processes + fake model boundary + isolated data.
5. Eval: versioned synthetic cases run through production storyboard validation,
   report score, fail below 100%. Mutation tests prove the gate rejects bad output.
   Online publication is explicit and separate from offline CI.

No test/cache hit is a substitute for external delivery verification. Sentry
delivery and Langfuse run visibility require configured accounts; report local
transport/harness checks separately. Live model quality evals come in a later
phase with budget, datasets, evaluator versions and human review.

## Deferred administration and operations

The admin app is a separate apps/admin workspace. Its first authenticated
screen verifies the local administrator role through the Go API. Task and cost
views remain unpopulated until their authoritative APIs are migrated. Planned modules:
- Generated content: project/task provenance, review status, filtering, retention,
  access control, export and audited moderation actions.
- Cost ledger: provider/model/version, usage units, price snapshot, currency,
  estimated vs settled cost, refunds/failures, per-project and per-user aggregation.
  Langfuse usage is diagnostic input, not the authoritative billing ledger.
- Operations: queues, worker heartbeats, stuck tasks, saved-artifact failures,
  rate limits, manual actions with audit history.
- Notifications: in-app inbox first; delivery preferences, read state, deduplication
  and retry policy; email/webhook adapters after explicit configuration.
- Alerts: error rate, queue age, worker health, provider failures, cost thresholds;
  grouping, cooldown, escalation and recovery messages.
- Security: administrator authentication, RBAC, project isolation, secret management,
  audit records and restricted access to production prompts/media.

Do not expose an unauthenticated admin shell as a completed management platform.

Environment files are expanded independently in the root and application layer.
For variables shared across layers, export the common value in the shell or repeat
it in the app's file; do not reference a root-only variable inside an app dotenv
value. Shell variables take precedence over both layers.

Langfuse publication uses JS/TS SDK 6 and therefore targets Langfuse Cloud v4 or
self-hosted v4.59+. An old v3 self-hosted instance must be upgraded before using
eval:publish. The local collector test verifies SDK trace/score delivery only;
it is not a substitute for checking the actual server version, credentials and
experiment visibility on the configured instance.
