# Go API

The Go API is being built by migrating one complete domain at a time. It does
not share authoritative writes with the legacy TypeScript implementation.

## Current domain boundary

The account domain is the first migrated vertical slice:

1. `internal/identity/oidc` verifies hosted identity tokens. It does not own
   business users or authorization.
2. `internal/account` contains account vocabulary and application rules. It
   depends only on its repository interface.
3. `internal/account/postgres` is the PostgreSQL adapter. It owns identity
   mapping, account state and append-only administrator audit writes.
4. `internal/httpserver` is the versioned HTTP adapter described by
   `openapi.yaml`.

Dependency direction is HTTP/OIDC/PostgreSQL adapters → account module. The
account module does not import Gin, GORM or an identity-provider SDK.

Generation and canvas data remain authoritative in `apps/web` until their full
transaction boundaries move. Do not add Go writes to the legacy SQLite tables
or create a second generation-task writer during the transition.

## Runtime configuration

- `DATABASE_URL`: PostgreSQL connection used by the API.
- `OIDC_ISSUER`: exact issuer used for discovery and token validation.
- `OIDC_AUDIENCE`: required JWT access-token audience for this API.
- `OIDC_MFA_AMR` / `OIDC_ADMIN_ACR`: selected provider profile values that
  prove MFA through the token's `amr` or `acr` claims; at least one is required.
- `INITIAL_ADMIN_SUBJECT`: optional external subject promoted to `admin` only
  when its local account is first created, its issuer matches `OIDC_ISSUER`, and
  no administrator exists yet. Changing this value cannot create a second
  initial administrator.

This slice intentionally supports the selected provider's signed JWT access-token
profile, including `email`, `email_verified`, `auth_time`, and configured
`amr`/`acr` claims. Opaque OAuth tokens require a future introspection adapter;
they are not accepted implicitly. The admin client must request an MFA step-up before sensitive
operations. The API independently requires the `mfa` authentication-method
claim and an `auth_time` no more than ten minutes old.

Migrations are a separate deployment step (`pnpm db:migrate`); API startup never
runs DDL. Without complete database and OIDC configuration, health remains
available but readiness is false and account routes fail closed.

## Deliberately incomplete in this slice

The protected historical-resource import, project/task ownership enforcement,
hosted-provider session revocation, generation authorization, and audit events
for admin login, sensitive-content access and task operations are not yet
implemented. They must arrive with the complete owning domain rather than by
dual-writing legacy SQLite and PostgreSQL.
