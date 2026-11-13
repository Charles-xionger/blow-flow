# PostgreSQL migrations

This directory is the single production schema owner. Phase 1 intentionally has
no domain tables: the existing application still owns its SQLite data.

Add reviewed, numbered Goose SQL files when migrating the first domain.
Run DATABASE_URL=... pnpm db:migrate as a deployment job, never in API/worker
startup. Do not use GORM AutoMigrate in production. Use expand/backfill/contract
for live changes; destructive rollback requires a separate data recovery plan.
The integration test exercises Goose with a disposable fixture schema.
