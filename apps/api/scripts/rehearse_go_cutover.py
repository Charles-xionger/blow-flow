#!/usr/bin/env python3
"""Run the synthetic Go cutover rehearsal in disposable local infrastructure.

The only accepted database is the PostgreSQL container created by this invocation.
The raw SQLite and export are removed on exit; sanitized evidence remains in --report.
"""

import argparse
import base64
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread
import time
from urllib.request import urlopen
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rehearsal_legacy_fixture import EXTERNAL_MEDIA_BYTES

ROOT = Path(__file__).resolve().parents[3]
API = ROOT / "apps/api"
COMPOSE = ROOT / "infra/compose.yaml"
CASES = {
    "imported_agent_is_read_only": "TestImportLegacyAgentHistoryWithoutReplayingGeneration",
    "go_canvas_agent_confirm_delivery": "TestRunTokenScopesCanvasCommitAndRecoversItsReceipt|TestGenerationApprovalCreatesExactTasksOnce|TestAgentDeliveryWritesSavedResultToCanvasOnce",
    "image_video_reference_and_cancel": "TestAgentGenerationFreezesOwnedOrderedReferences|TestAgentH3VideoReferenceDefaultsToOriginalAudio|TestGenerationApprovalCancelAndStaleCanvasNeverSubmit",
    "generation_replay_failure_and_lost_wakeup": "TestPostgresOutboxRabbitWorkerDuplicateAndCancel|TestSubmissionCapacityAndUncertainResponse|TestSubmissionWorkerRecoversPublishedTaskWithoutRabbitMessage|TestProviderSuccessSaveRetryAndEventsSurviveRestart|TestGenerationSSEAcrossInstancesAndRedisFailure",
    "script_checkpoint_replay": "TestTaskOwnershipReplayAndCanvasOutput|TestExpiredWorkerSavesPartialTextAndEvents|TestWorkflowCheckpointRetryAndCompletion",
}
IMPORT_TABLES = {
    "projects": "projects", "folders": "project_folders", "mediaFiles": "media_assets",
    "saveReceipts": "project_save_receipts", "deletedNodes": "project_deleted_nodes",
    "scriptTasks": "script_tasks", "scriptRequests": "script_requests",
    "agentTasks": "agent_tasks", "agentMessages": "agent_messages",
    "agentReceipts": "agent_legacy_command_receipts",
    "agentCanvasReceipts": "agent_legacy_canvas_receipts",
    "agentGenerationBatches": "agent_legacy_generation_batches",
    "userSkills": "user_skills", "userSkillResources": "user_skill_resources",
}
IMPORT_IDENTITIES = {
    "projects": ("id", "id"), "folders": ("id", "id"), "mediaFiles": ("id", "id"),
    "saveReceipts": ("canvas_id,request_id", "project_id || ':' || request_id"),
    "deletedNodes": ("canvas_id,node_id", "project_id || ':' || node_id"),
    "scriptTasks": ("id", "id::text"), "scriptRequests": ("request_id", "request_id"),
    "agentTasks": ("id", "id::text"), "agentMessages": ("id", "id::text"),
    "agentReceipts": ("project_id,request_id", "project_id || ':' || request_id"),
    "agentCanvasReceipts": ("project_id,identity", "project_id || ':' || identity"),
    "agentGenerationBatches": ("id", "id"), "userSkills": ("name", "name"),
    "userSkillResources": ("skill_name,path", "skill_name || ':' || path"),
}


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run(args, *, env=None, cwd=ROOT, capture=True):
    result = subprocess.run(args, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT if capture else None)
    if result.returncode:
        output = result.stdout or ""
        failures = [line for line in output.splitlines() if "--- FAIL:" in line or "_test.go:" in line or line.startswith("FAIL")]
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {'; '.join(failures)[:3000] or output[-3000:]}")
    return result.stdout or ""


def pg(compose, env, query):
    return run(compose + ["exec", "-T", "postgres", "psql", "-At", "-U", "ai_flow", "-d", "ai_flow", "-c", query], env=env).strip()


def validate_identity(run_id, env):
    if not re.fullmatch(r"rehearsal_[0-9a-f]{12}", run_id):
        raise ValueError("invalid run-specific Compose identity")
    if env["COMPOSE_PROJECT_NAME"] != run_id or env["POSTGRES_VOLUME_NAME"] != run_id + "_postgres" or env["RABBITMQ_VOLUME_NAME"] != run_id + "_rabbit":
        raise ValueError("Compose project or volumes are not run-specific")
    ports = [int(env[key]) for key in ("POSTGRES_PORT", "REDIS_PORT", "RABBITMQ_PORT", "RABBITMQ_MANAGEMENT_PORT")]
    if len(set(ports)) != 4 or any(port <= 1024 or port in {5432, 6379, 5672, 15672, 15432, 16379, 15673} for port in ports):
        raise ValueError("unsafe or shared service port")


@contextmanager
def external_media_fixture():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/fixture/video.mp4":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(EXTERNAL_MEDIA_BYTES)))
            self.end_headers()
            self.wfile.write(EXTERNAL_MEDIA_BYTES)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/fixture/video.mp4"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def verify_imported_media(inline_url, external_url, expected_external_url, manifest):
    if external_url != expected_external_url or not inline_url.startswith("data:image/png;base64,"):
        return False
    try:
        inline = base64.b64decode(inline_url.split(",", 1)[1], validate=True)
        with urlopen(external_url, timeout=5) as response:
            external = response.read(len(EXTERNAL_MEDIA_BYTES) + 1)
    except Exception:
        return False
    return (hashlib.sha256(inline).hexdigest() == manifest["inlineMediaSha256"]
            and hashlib.sha256(external).hexdigest() == manifest["externalMediaSha256"])


def restore_legacy_read_entry(database, legacy_project_ids, go_project_ids):
    """Reopen the disposable pre-cutover entry without permitting a new writer."""
    uri = database.resolve().as_uri() + "?mode=ro&immutable=1"
    with sqlite3.connect(uri, uri=True) as connection:
        connection.execute("PRAGMA query_only=ON")
        found_legacy = sorted(row[0] for row in connection.execute(
            "SELECT id FROM workflows WHERE id IN (" + ",".join("?" for _ in legacy_project_ids) + ")",
            legacy_project_ids))
        visible_go = sorted(row[0] for row in connection.execute(
            "SELECT id FROM workflows WHERE id IN (" + ",".join("?" for _ in go_project_ids) + ")",
            go_project_ids)) if go_project_ids else []
        if found_legacy != sorted(legacy_project_ids) or visible_go:
            raise RuntimeError("restored legacy entry differs from pre-cutover state")
        try:
            connection.execute("INSERT INTO workflows(id,data) VALUES('forbidden-rollback-write','{}')")
        except sqlite3.OperationalError:
            pass
        else:
            raise RuntimeError("legacy rollback entry accepted a write")
    return {"legacyProjectIds": found_legacy, "goOnlyProjectIdsVisible": visible_go, "mode": "read-only"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True, help="new JSON evidence path")
    args = parser.parse_args()
    report = args.report.resolve()
    if report.exists():
        parser.error("report exists; refusing to overwrite")
    if not shutil.which("docker") or not shutil.which("go"):
        parser.error("docker and go are required")
    run_id = "rehearsal_" + secrets.token_hex(6)
    ports = {name: available_port() for name in ("postgres", "redis", "rabbit", "rabbit_management")}
    env = os.environ.copy()
    for key in list(env):
        if key in {"DATABASE_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD", "CREATOR_SETUP_PASSWORD", "AUTH_SIGNING_KEY", "AGENT_RUNNER_KEY"} or key.startswith(("RUNNINGHUB_", "OSS_")):
            env.pop(key)
    env.update({
        "COMPOSE_PROJECT_NAME": run_id,
        "POSTGRES_VOLUME_NAME": run_id + "_postgres",
        "RABBITMQ_VOLUME_NAME": run_id + "_rabbit",
        "POSTGRES_PORT": str(ports["postgres"]),
        "REDIS_PORT": str(ports["redis"]),
        "RABBITMQ_PORT": str(ports["rabbit"]),
        "RABBITMQ_MANAGEMENT_PORT": str(ports["rabbit_management"]),
        "POSTGRES_PASSWORD": secrets.token_urlsafe(24),
    })
    env["DATABASE_URL"] = f"postgres://ai_flow:{env['POSTGRES_PASSWORD']}@127.0.0.1:{ports['postgres']}/ai_flow?sslmode=disable"
    env["TEST_DATABASE_URL"] = env["DATABASE_URL"]
    env["TEST_REDIS_URL"] = f"redis://127.0.0.1:{ports['redis']}/0"
    env["TEST_RABBITMQ_URL"] = f"amqp://guest:guest@127.0.0.1:{ports['rabbit']}/"
    validate_identity(run_id, env)
    compose = ["docker", "compose", "-f", str(COMPOSE), "-p", run_id]
    evidence = {"runId": run_id, "commit": run(["git", "rev-parse", "HEAD"]).strip(),
                "ports": ports, "cases": {}, "startedAt": time.time(), "productionGates": [
                    "production backup and destination confirmed", "production provider credentialed smoke run",
                    "Go-only data disposition or reverse migration before rollback", "operations monitoring and public account lifecycle"]}
    report.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=run_id + "_") as tmp, external_media_fixture() as media_url:
        fixture_dir = Path(tmp) / ("go-cutover-" + run_id.removeprefix("rehearsal_"))
        legacy_db = fixture_dir / "legacy.sqlite"
        export = fixture_dir / "legacy-export.json"
        try:
            evidence["startupAttempts"] = []
            for attempt in range(2):
                try:
                    run(compose + ["up", "-d", "--wait", "postgres", "redis", "rabbitmq"], env=env)
                    evidence["startupAttempts"].append("pass")
                    break
                except RuntimeError as exc:
                    evidence["startupAttempts"].append("fail: " + str(exc)[-400:])
                    if attempt == 1:
                        raise
            evidence["cases"]["isolated_services"] = "pass"
            run(["python3", str(API / "scripts/rehearsal_legacy_fixture.py"), "--run-id", run_id.removeprefix("rehearsal_"), "--run-dir", str(fixture_dir), "--media-url", media_url])
            env["REHEARSAL_MEDIA_URL"] = media_url
            evidence["fixture"] = json.loads((fixture_dir / "fixture-manifest.json").read_text())
            before_sqlite_digest = hashlib.sha256(legacy_db.read_bytes()).hexdigest()
            evidence["fixtureSha256"] = hashlib.sha256(export.read_bytes()).hexdigest()
            evidence["fixtureCounts"] = {k: len(v) for k, v in json.loads(export.read_text()).items() if isinstance(v, list)}
            run(["go", "run", "./cmd/migrate"], cwd=API, env=env)
            env["CREATOR_SETUP_PASSWORD"] = secrets.token_urlsafe(30)
            env["REHEARSAL_CREATOR_PASSWORD"] = env["CREATOR_SETUP_PASSWORD"]
            env["REHEARSAL_CREATOR_EMAIL"] = run_id + "@example.test"
            creator = run(["go", "run", "./cmd/creator-setup", "-email", env["REHEARSAL_CREATOR_EMAIL"]], cwd=API, env=env)
            owner = creator.strip().split()[-1]
            env.pop("CREATOR_SETUP_PASSWORD")
            evidence["ownerId"] = owner
            env["REHEARSAL_OWNER_ID"] = owner
            env["REHEARSAL_EXPORT_FILE"] = str(export)
            run(["go", "run", "./cmd/import-legacy-resources", "-file", str(export), "-owner", owner, "-oss-host", "fixture.invalid", "-apply"], cwd=API, env=env)
            run(["go", "run", "./cmd/import-legacy-resources", "-file", str(export), "-owner", owner, "-oss-host", "fixture.invalid", "-apply"], cwd=API, env=env)
            evidence["cases"]["import_dry_run_and_idempotent_apply"] = "pass"
            imported_counts = {key: int(pg(compose, env, "SELECT count(*) FROM " + table)) for key, table in IMPORT_TABLES.items()}
            evidence["importedCounts"] = imported_counts
            evidence["cases"]["all_resource_counts"] = "pass" if imported_counts == evidence["fixtureCounts"] else "fail: imported counts differ"
            owner_count = int(pg(compose, env, "SELECT count(*) FROM projects WHERE owner_id='" + owner + "'"))
            evidence["cases"]["imported_project_owner"] = "pass" if owner_count == evidence["fixtureCounts"]["projects"] else "fail: imported owner mismatch"
            exported = json.loads(export.read_text())
            id_mismatches = []
            for key, (source_columns, expression) in IMPORT_IDENTITIES.items():
                columns = source_columns.split(",")
                expected = sorted(":".join(str(row[column]) for column in columns) for row in exported[key])
                actual = sorted(pg(compose, env, "SELECT " + expression + " FROM " + IMPORT_TABLES[key]).splitlines())
                if expected != actual:
                    id_mismatches.append(key)
            evidence["cases"]["all_resource_identifiers"] = "pass" if not id_mismatches else "fail: IDs differ in " + ",".join(id_mismatches)
            active = next(project for project in exported["projects"] if project["id"] == "fixture-project-active")
            imported_snapshot = json.loads(pg(compose, env, "SELECT snapshot FROM projects WHERE id='fixture-project-active'"))
            imported_version = int(pg(compose, env, "SELECT version FROM projects WHERE id='fixture-project-active'"))
            imported_folder = pg(compose, env, "SELECT folder_id FROM projects WHERE id='fixture-project-active'")
            trashed = pg(compose, env, "SELECT deleted_at IS NOT NULL FROM projects WHERE id='fixture-project-trashed'")
            evidence["cases"]["project_content_ids_versions_and_trash"] = "pass" if (imported_snapshot == json.loads(active["data"]) and imported_version == active["version"] and imported_folder == active["folder_id"] and trashed == "t") else "fail: imported project differs"
            skill_hex = pg(compose, env, "SELECT encode(content,'hex') FROM user_skill_resources WHERE owner_id='" + owner + "' AND skill_name='fixture-skill' AND path='assets/reference.bin'")
            evidence["cases"]["skill_binary_content_and_owner"] = "pass" if hashlib.sha256(bytes.fromhex(skill_hex)).hexdigest() == evidence["fixture"]["skillResourceSha256"] else "fail: skill resource differs"
            inline_url = pg(compose, env, "SELECT url FROM media_assets WHERE id='fixture-media-inline' AND owner_id='" + owner + "'")
            oss_url = pg(compose, env, "SELECT url FROM media_assets WHERE id='fixture-media-oss' AND owner_id='" + owner + "'")
            evidence["cases"]["media_content_ids_and_owner"] = "pass" if verify_imported_media(inline_url, oss_url, media_url, evidence["fixture"]) else "fail: imported media bytes differ"
            legacy_status = pg(compose, env, "SELECT status || ':' || legacy_imported FROM agent_tasks WHERE id='44444444-4444-4444-8444-444444444444'")
            no_legacy_outbox = pg(compose, env, "SELECT count(*) FROM agent_outbox") == "0" and pg(compose, env, "SELECT count(*) FROM generation_outbox") == "0"
            evidence["cases"]["old_confirmation_interrupted_without_requeue"] = "pass" if legacy_status == "interrupted:true" and no_legacy_outbox else "fail: old task may be executable"
            baseline = pg(compose, env, "SELECT count(*) FROM projects")
            for name, pattern in CASES.items():
                try:
                    run(["go", "test", "-tags=integration", "-count=1", "./internal/...", "-run", "^(" + pattern + ")$"], cwd=API, env=env)
                    evidence["cases"][name] = "pass"
                except Exception as exc:
                    evidence["cases"][name] = "fail: " + str(exc)[-3000:]
            try:
                run(["go", "test", "-tags=integration", "-count=1", "./internal/httpserver", "-run", "^TestImportedCutoverAPIJourney$"], cwd=API, env=env)
                evidence["cases"]["imported_api_journey"] = "pass"
            except Exception as exc:
                evidence["cases"]["imported_api_journey"] = "fail: " + str(exc)[-3000:]
            after = pg(compose, env, "SELECT count(*) FROM projects")
            evidence["delta"] = {"projectsBefore": int(baseline), "projectsAfter": int(after),
                                 "goOnlyProjectIds": pg(compose, env, "SELECT coalesce(string_agg(id,',' ORDER BY id),'') FROM projects WHERE id LIKE 'go-rehearsal-%'").split(","),
                                 "goCanvasVersions": pg(compose, env, "SELECT coalesce(string_agg(id || ':' || version::text,',' ORDER BY id),'') FROM projects WHERE id LIKE 'go-rehearsal-%'").split(","),
                                 "goAgentTaskIds": pg(compose, env, "SELECT coalesce(string_agg(id::text,',' ORDER BY id::text),'') FROM agent_tasks WHERE legacy_imported=false").split(","),
                                 "goScriptTaskIds": pg(compose, env, "SELECT coalesce(string_agg(id::text,',' ORDER BY id::text),'') FROM script_tasks WHERE request_id='rehearsal-script'").split(","),
                                 "goGenerationTaskIds": pg(compose, env, "SELECT coalesce(string_agg(id::text,',' ORDER BY id::text),'') FROM generation_tasks").split(","),
                                 "deliveredGenerationCount": int(pg(compose, env, "SELECT count(*) FROM generation_tasks WHERE status='completed' AND result_url<>''"))}
            legacy_ids = {project["id"] for project in exported["projects"]}
            go_ids = set(evidence["delta"]["goOnlyProjectIds"])
            evidence["cases"]["stop_and_delta_manifest"] = "pass" if int(after) > int(baseline) and not go_ids.intersection(legacy_ids) and evidence["delta"]["deliveredGenerationCount"] > 0 else "fail: Go-only data not reconciled"
            evidence["sqliteSha256AfterGoWrites"] = hashlib.sha256(legacy_db.read_bytes()).hexdigest()
            evidence["cases"]["single_writer_sqlite_unchanged"] = "pass" if evidence["sqliteSha256AfterGoWrites"] == before_sqlite_digest else "fail: legacy SQLite changed"
            # The API/worker journey has stopped. Export its synthetic Go-only
            # rows before switching back to the immutable legacy entry.
            delta_export = {
                "projects": json.loads(pg(compose, env, "SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT id,owner_id,name,snapshot,version FROM projects WHERE id LIKE 'go-rehearsal-%' ORDER BY id) t")),
                "agentTasks": json.loads(pg(compose, env, "SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT id,project_id,status FROM agent_tasks WHERE legacy_imported=false ORDER BY id) t")),
                "generationTasks": json.loads(pg(compose, env, "SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT id,project_id,status,result_url FROM generation_tasks ORDER BY id) t")),
                "scriptTasks": json.loads(pg(compose, env, "SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT id,project_id,status,text FROM script_tasks WHERE request_id='rehearsal-script' ORDER BY id) t")),
            }
            delta_bytes = json.dumps(delta_export, sort_keys=True, separators=(",", ":")).encode()
            delta_path = Path(tmp) / "go-only-delta.json"
            delta_path.write_bytes(delta_bytes)
            delta_path.chmod(0o600)
            reconciled = (sorted(row["id"] for row in delta_export["projects"]) == sorted(go_ids)
                          and sorted(row["id"] for row in delta_export["generationTasks"]) == sorted(x for x in evidence["delta"]["goGenerationTaskIds"] if x))
            evidence["deltaExportSha256"] = hashlib.sha256(delta_path.read_bytes()).hexdigest()
            evidence["cases"]["go_only_export_reconciled"] = "pass" if reconciled else "fail: Go-only export IDs differ"
            restored = restore_legacy_read_entry(legacy_db, sorted(legacy_ids), sorted(go_ids))
            evidence["rollback"] = {"entry": restored, "goOnlyDisposition": "Synthetic Go-only rows exported and reconciled, then deliberately discarded with disposable infrastructure; no production reverse migration is claimed."}
            evidence["cases"]["legacy_read_only_entry_restored"] = "pass" if restored["mode"] == "read-only" and hashlib.sha256(legacy_db.read_bytes()).hexdigest() == before_sqlite_digest else "fail: legacy entry not restored"
        except Exception as exc:
            evidence["fatal"] = str(exc)[-1500:]
        finally:
            evidence["finishedAt"] = time.time()
            try:
                validate_identity(run_id, env)
                run(compose + ["down", "-v", "--remove-orphans"], env=env)
                evidence["cases"]["isolated_teardown"] = "pass"
            except Exception as exc:
                evidence["cases"]["isolated_teardown"] = "fail: " + str(exc)[-500:]
            report.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
            report.chmod(0o600)
    print(report)
    return 1 if evidence.get("fatal") or any(str(v).startswith("fail") for v in evidence["cases"].values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
