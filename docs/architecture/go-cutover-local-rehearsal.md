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

## Observed local run, 2026-11-20

The [sanitized evidence](go-cutover-rehearsal-2026-11-20.json) is from commit
`a46c94435336fb0571b4900806a7150ae99abfd0`, run
`rehearsal_14672adbf02b` (55.6 seconds). All 18 recorded cases passed. The
fixture exported two projects, one folder, two media files, two script tasks,
two Agent tasks and messages, one personal skill and resource, plus save,
deleted-node and legacy command receipts. Every exported resource count and
identifier matched PostgreSQL after import. Canvas content, version, folder,
trash state, media content, skill bytes and owner matched. The old waiting Agent
task was interrupted with no legacy generation outbox.

The imported creator logged in through Go, read the workspace, saved and
replayed a canvas request, sent an Agent command, used the internal canvas tool,
confirmed one image and one video generation, and read both delivered results
and a completed script result from the saved project. A newly built API router
read the saved state, and a second owner received 404 for project, Agent and task
reads. Focused integration cases exercised replay, lost Rabbit wakeup and Redis
notification, uncertain supplier response, task failure and retry, late delivery,
script checkpoint recovery and old Agent read-only isolation. All supplier
responses in this run were fake.

The legacy SQLite digest stayed unchanged while Go created one new project
(canvas version 7), one Agent task, one script task and two delivered generation
tasks. The delta manifest lists Go-only IDs and confirms that the legacy export
lacks them. All run-specific containers and volumes were removed.

Earlier setup attempts failed before rehearsal cases ran: one fresh RabbitMQ
container exited during startup, and one fresh worktree lacked installed Node
dependencies. A later API test attempt exposed missing fake model configuration
at generation preparation. The runner now has a bounded startup retry, the
worktree dependencies were installed, and the fake model configuration was
fixed. These failed attempts were not counted as passing evidence.

This run used API and store boundaries, including fake suppliers; it did not
start the full Web UI or make paid supplier calls. Restart behavior was tested by
recreating the API router and through dedicated persistence/recovery integration
cases, not by killing a live production process. The Go-only delta is preserved
in the report, but reverse migration is still absent. Production cutover remains
gated on backups, credentialed provider smoke checks, monitoring and a decision
for Go-only data if rollback is needed.

Validation on the final source: typecheck and lint passed, the Python fixture
and isolation tests passed (3/3), and the full fast suite passed on its final
run (Web 345/345; all API, admin and eval tasks passed). An earlier full fast
run had one Web autosave test fail on a short timeout assertion under load
(344/345 Web); that case passed a focused rerun, followed by the passing full
run. No application source was changed between those two fast runs.
