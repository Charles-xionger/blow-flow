# AI Flow

AI creative canvas. pnpm Workspace + Turborepo manages the repository; Next.js
serves the existing product and Gin is the foundation for gradual Go migration.

## Layout

- apps/web: existing Next.js canvas, APIs and generation/Agent/script workers.
- apps/api: Go + Gin API, GORM/PostgreSQL connection, versioned migration runner.
- packages/evals: deterministic evaluation dataset, CI gate and explicit Langfuse publication.
- infra: local PostgreSQL Compose configuration.
- docs/architecture: migration boundaries and operational conventions.
- .scratch/monorepo-foundation/spec.md: phased delivery plan.

No business data is moved in phase 1. Existing SQLite files stay under root data/.
The production replacement is PostgreSQL; SQLite is transitional legacy storage.

## Requirements and setup

Node 22.14 (nvm use), pnpm 10.18.3, Go 1.24+, Docker with Compose v2.

    nvm use
    pnpm install --frozen-lockfile
    pnpm db:up
    export DATABASE_URL='postgres://ai_flow:ai_flow_local@127.0.0.1:15432/ai_flow?sslmode=disable'
    pnpm dev:all

Web is on port 3000; Gin is on 8080. Ctrl-C stops the foreground stack.
pnpm dev starts only Web; pnpm dev:api starts only Gin.
Legacy Web configuration in root .env.local is still loaded by normal app/worker
launch scripts. Relative DATABASE_PATH values keep their repository-root meaning.
The Go API and eval publication accept explicitly exported variables; see their
.env.example files. Do not copy production credentials into CI.

Gin endpoints:
- GET /health/live: process alive, independent of the database.
- GET /health/ready: 200 only when PostgreSQL is reachable; otherwise 503.
- Each response carries a server-generated X-Request-ID.
- No business APIs or user authentication have been migrated yet.

pnpm db:down stops the development database without deleting its volume.
Migration files belong in apps/api/migrations; pnpm db:migrate runs reviewed SQL.
There are intentionally no domain migrations yet.

## Validation

    pnpm typecheck
    pnpm lint
    pnpm test
    TEST_DATABASE_URL='postgres://.../disposable_test_db' pnpm test:integration
    pnpm test:e2e
    pnpm eval

- test: Go race tests, existing Web unit/service tests and eval gate tests.
- test:integration: real PostgreSQL + Goose + GORM, isolated temporary schema.
  An absent TEST_DATABASE_URL fails. Use a disposable database, never production.
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
