---
status: accepted
---

# Go API owns login and issues short-lived JWTs

We replace the hosted OIDC login chosen in ADR-0017 with authentication owned by the Go API. The API keeps business user IDs, roles and account status in PostgreSQL, and issues short-lived signed JWTs after verifying credentials; every protected request checks current account state. The initial administrator uses a locally generated password hash and TOTP secret, with MFA required before a token is issued. If an OIDC-era administrator already exists, its local user ID is preserved only when exactly one active administrator has the configured email; otherwise bootstrap fails closed. This avoids an external identity service but makes password recovery, credential rotation, session management, rate limiting and MFA recovery our responsibility as the account domain expands. The current bootstrap login is for the first administrator only; it does not imply that public registration or password recovery has shipped.
