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
binary resource, then uses the read-only legacy exporter. The rehearsal imports
it twice into the isolated Go database, compares every resource count and
checks representative content, owner and interrupted history. The Go HTTP test
uses that imported account to exercise the cutover API. Focused integration
cases cover generation, script and Agent recovery, duplicate messages, Redis
notification loss, failure and late delivery. Finally, the runner compares the
legacy SQLite digest and emits a manifest of Go-only IDs before destroying the
disposable database.

The local rollback proof is a safe stop plus delta capture. It is **not** a
lossless reverse migration: the legacy SQLite cannot serve Go-only projects or
tasks. Production rollback requires a disposition for those IDs and results,
confirmed backups, credentialed provider smoke checks and monitoring. This
script does not change production routing or exercise the Next.js browser UI.
