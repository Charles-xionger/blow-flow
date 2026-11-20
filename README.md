# Blow Flow

AI creative canvas. pnpm Workspace + Turborepo manages the repository. Next.js
serves the existing product while the Go API and workers run as separate services.

## Layout

- apps/web: Next.js canvas and the legacy SQLite generation/Agent/script workers.
- apps/api: Go API, PostgreSQL migrations, generation/script workers and Agent dispatcher.
- packages/evals: deterministic evaluation dataset, CI gate and explicit Langfuse publication.
- infra: local PostgreSQL, RabbitMQ and Redis Compose configuration.
- docs/architecture: migration boundaries and operational conventions.
- .scratch/monorepo-foundation/spec.md: phased delivery plan.

Existing SQLite files stay under root data/. The Go API uses PostgreSQL; the
browser product still has legacy Next.js/SQLite paths. Do not write the same
project through both backends.
Existing browser storage keys, PostgreSQL database credentials, and the Docker
volume keep their original `ai-flow` identifiers so existing local data remains
accessible after the product rename.

## Requirements and setup

Node 22.14 (nvm use), pnpm 10.18.3, Go 1.24+, Docker with Compose v2.

    nvm use
    pnpm install --frozen-lockfile
    pnpm db:up
    export DATABASE_URL='postgres://ai_flow:ai_flow_local@127.0.0.1:15432/ai_flow?sslmode=disable'
    export RABBITMQ_URL='amqp://guest:guest@127.0.0.1:15672/'
    export REDIS_URL='redis://127.0.0.1:16379/0'
    pnpm db:migrate
    pnpm dev:all

`db:up` waits for PostgreSQL, RabbitMQ and Redis. Web is on port 3000; the Go
API is on 8080. `dev:all` starts Web and its legacy workers, Admin, the Go API,
Go generation and script workers, and the Go Agent dispatcher. Ctrl-C stops
the foreground stack. `pnpm dev` starts only Web; `pnpm dev:web` starts Web and
its legacy workers. `pnpm dev:api` starts only the Go API; `pnpm dev:go` starts
the Go API and its background processes.
Standalone `pnpm generation:worker`, `pnpm agent:worker` and
`pnpm script:worker` retain the Web/SQLite workers. Use the `go:` worker
commands or the API package scripts to run Go workers separately.
The Go Agent Runner is opt-in with `pnpm agent:go-worker`; its public command
routes require `AGENT_GO_EXPERIMENTAL_COMMANDS=1` for controlled smoke tests.
Legacy Web configuration in root .env.local is still loaded by normal app/worker
launch scripts. Relative DATABASE_PATH values keep their repository-root meaning.
The Go API launcher loads root and `apps/api/.env.local` values; see
`apps/api/.env.example` for RabbitMQ, Redis and provider settings. Configure
the local admin separately with `pnpm admin:setup`. Do not copy production
credentials into CI.

Gin endpoints:
- GET /health/live: process alive, independent of the database.
- GET /health/ready: 200 only when PostgreSQL is reachable; otherwise 503.
- Each response carries a server-generated X-Request-ID.
- Versioned account, project, generation, script and Agent APIs are implemented;
  see `apps/api/README.md` for current cutover boundaries.

pnpm db:down stops the local dependencies without deleting their volumes.
Migration files belong in apps/api/migrations; pnpm db:migrate runs reviewed SQL.

## Validation

    pnpm typecheck
    pnpm lint
    pnpm test
    TEST_DATABASE_URL='postgres://.../disposable_test_db' pnpm test:integration
    pnpm test:e2e
    pnpm test:browser
    pnpm test:browser:full
    pnpm eval

- test: Go race tests, existing Web unit/service tests and eval gate tests.
- test:integration: real PostgreSQL + Goose + GORM, isolated temporary schema.
  An absent TEST_DATABASE_URL fails. Use a disposable database, never production.
- test:browser: representative local Playwright suite (36 cases).
- test:browser:full: all Playwright cases.
- test:e2e: builds and starts a real Gin process, then runs the full Playwright canvas suite.
  The browser harness owns temporary SQLite, ports 3217/3218 and fake providers.
- eval: offline, synthetic dataset, no LLM requests or external writes.
- eval:publish: explicit upload of the synthetic experiment to configured Langfuse.
  Requires LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY. This is infrastructure
  validation, not a claim that model output quality has been evaluated.
- build: production Web build and Go executable.

CI runs these layers separately and saves failure artifacts and evaluation reports.
Browser runs must keep source files unchanged; the source guard spans the monorepo.
External service credentials and paid model evaluations are not required for PR CI.

## Observability

Sentry errors are opt-in with SENTRY_DSN (server) and NEXT_PUBLIC_SENTRY_DSN
(browser). Replays and tracing are disabled in this phase. The event scrubber
removes request payloads, user data, breadcrumbs and error values; preserves stack
frames and allowlisted correlation tags. Set SENTRY_RELEASE for release attribution.
For source maps, configure SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT in CI.
Never expose the auth token through NEXT_PUBLIC_*.

The existing Agent Langfuse tracing remains available. It records prompt/output
content after credential redaction, unlike the content-free Sentry policy.
Use approved synthetic datasets in evals; production content export needs its own
retention/access policy before rollout.

See docs/architecture/foundation.md for boundaries and the rollout plan.
