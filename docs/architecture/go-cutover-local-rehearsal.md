# Go cutover local rehearsal

This rehearsal uses synthetic creator content only. It creates a new SQLite file,
Compose project, PostgreSQL and RabbitMQ volumes, and nondefault localhost ports
for each run. It never reads `data/canvas.db` or the repository `.env.local`.
The script removes raw SQLite and export data and tears down only its own Compose
project. The JSON report is mode `0600` and contains counts, IDs, digests and
case outcomes, not prompts, passwords or provider keys.

Run from the repository root with Node 22 and dependencies installed:

```sh
python3 apps/api/scripts/rehearse_go_cutover.py --report /secure/new-report.json
```

The runner requires Docker and Go. It refuses to overwrite an existing report.
It validates its generated project, volume and port names before startup and
again before teardown. A failed fresh RabbitMQ start gets one bounded retry;
both attempts are recorded. Every case has a `pass` or `fail` result. A failure
returns a nonzero exit status while still tearing down disposable resources.

The fixture initializes the legacy Web schema, seeds projects, a folder, canvas
and receipts, media, script tasks, Agent history and a personal skill with a
binary resource, then uses the read-only legacy exporter. The external video
is served by a run-specific localhost fixture. The runner fetches its bytes
and compares their digest, decodes and hashes inline image bytes, and checks
owner access and cross-owner denial through the Go asset route.

The Go HTTP journey uses the imported creator account. It starts the real Node
Pi Runner with a deterministic model stream, so its canvas edit and generation
confirmation pass through MCP and Go HTTP. After the owner approves, the real
Go submission and delivery workers call fake RunningHub image and H3 adapters;
the fake supplier supplies task IDs, output queries and WebSocket progress.
A fake artifact store returns deterministic saved URLs. The journey verifies
one provider submission per task, progress events, saved results, owner-scoped
reads, duplicate wakeups and the resumed Runner's completion. Focused tests
still cover recovery, failure, Redis loss and script checkpoints.

After Go writes stop, the runner exports synthetic Go-only project and task rows
into a private temporary delta, reconciles their IDs and records its digest.
It then reopens the disposable legacy SQLite as immutable read-only, verifies
its prior projects are readable, confirms Go-only IDs are absent and rejects a
write. The temporary delta and both databases are deliberately discarded on
teardown. This is a safe local restoration of the old read entry with an
explicit synthetic-data disposition; it is not a lossless reverse migration.
Production rollback still needs a disposition for real Go-only data, confirmed
backups, credentialed provider smoke checks and monitoring. The rehearsal does
not change production routing or exercise the full browser UI.

## Observed local run, 2026-11-20

The [review-fix evidence](go-cutover-rehearsal-review-fixes-2026-11-20.json) records
a disposable local run of 20/20 cases. It includes imported resource counts,
identifiers, content checks, owner access, the joined Node Pi Runner and Go
worker journey, and the read-only legacy restoration. No paid supplier request
or real supplier credential was used. The prior
[18-case evidence](go-cutover-rehearsal-2026-11-20.json) remains as a historical
record; its API journey manually advanced generation store states and its
rollback stopped at a delta manifest, so it did not prove those two paths.
