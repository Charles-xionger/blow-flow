#!/usr/bin/env python3
"""Create a disposable legacy SQLite fixture and validate its Go import export.

The caller owns the newly created run directory. Never point this at an existing
database or a shared Compose volume. No network service or PostgreSQL is used.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sqlite3
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
STAMP = 1760000000000
PROJECT = "fixture-project-active"
TRASHED = "fixture-project-trashed"
FOLDER = "fixture-folder"
SCRIPT_DONE = "11111111-1111-4111-8111-111111111111"
SCRIPT_RUNNING = "22222222-2222-4222-8222-222222222222"
AGENT_DONE = "33333333-3333-4333-8333-333333333333"
AGENT_WAITING = "44444444-4444-4444-8444-444444444444"
MESSAGE_DONE = "55555555-5555-4555-8555-555555555555"
MESSAGE_WAITING = "66666666-6666-4666-8666-666666666666"
SKILL_BYTES = b"\x00\xfffixture skill resource\n"
MEDIA_BYTES = b"\x89PNG\r\n\x1a\nfixture"
EXTERNAL_MEDIA_BYTES = b"\x00\x00\x00\x18ftypmp42fixture-video"


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def initialize_application_schema(database):
    env = os.environ.copy()
    env["DATABASE_PATH"] = str(database)
    # This invokes the same schema initialization used by the legacy Web app.
    subprocess.run(
        ["pnpm", "exec", "tsx", "-e", "import {getDatabase,closeDatabase} from './lib/db/index'; getDatabase(); closeDatabase();"],
        cwd=ROOT / "apps/web", env=env, check=True, stdout=subprocess.DEVNULL,
    )
    # These services own their own tables, which getDatabase does not create.
    subprocess.run(
        ["pnpm", "exec", "tsx", "-e", "import {getDatabase,closeDatabase} from './lib/db/index'; import {ScriptService} from './lib/script/service'; import {AgentService} from './lib/agent/service'; import './lib/agent/generation'; import './lib/agent/canvas'; const db=getDatabase(); new ScriptService(db); new AgentService(db); db.exec('CREATE TABLE IF NOT EXISTS agent_generation_batches(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_canvas_receipts(project_id TEXT,identity TEXT,digest TEXT,result TEXT,PRIMARY KEY(project_id,identity))'); closeDatabase();"],
        cwd=ROOT / "apps/web", env=env, check=True, stdout=subprocess.DEVNULL,
    )


def seed(database, media_url="https://fixture.invalid/fixture/video.mp4"):
    active_canvas = {"name": "Fixture active", "nodes": [
        {"id": "fixture-script-node", "type": "script", "position": {"x": 40, "y": 50}, "data": {"prompt": "Fixture scene"}},
        {"id": "fixture-text-node", "type": "text", "position": {"x": 350, "y": 50}, "data": {"text": "Saved scene"}},
    ], "edges": [{"id": "fixture-edge", "source": "fixture-script-node", "target": "fixture-text-node"}], "viewport": {"x": 2, "y": 3, "zoom": 1.25}}
    trashed_canvas = {"name": "Fixture trashed", "nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}
    script_input = compact({"model": "fixture-text-model", "prompt": "Fixture scene", "references": [], "outputMode": "text"})
    checkpoint = compact({"steps": [{"id": "plan", "status": "completed", "text": "Scene plan"}, {"id": "write", "status": "pending"}]})
    done_task = {"id": AGENT_DONE, "projectId": PROJECT, "modelId": "fixture-model", "status": "completed", "createdAt": STAMP, "steps": []}
    waiting_task = {"id": AGENT_WAITING, "projectId": PROJECT, "modelId": "fixture-model", "status": "waiting", "createdAt": STAMP + 1,
                    "question": {"id": "old-approval", "text": "Approve old request?", "options": ["yes"], "scope": {"kind": "generation", "items": []}},
                    "steps": [{"id": "old-tool-step", "name": "prepare_generation", "args": {}, "status": "completed", "result": {"waiting": True}}]}
    with sqlite3.connect(database) as db:
        db.execute("INSERT INTO project_folders VALUES(?,?,?,?)", (FOLDER, "Fixture folder", STAMP, STAMP))
        db.execute("INSERT INTO workflows(id,name,data,created_at,updated_at,version,deleted_at,folder_id,purged_at,cover_url,node_count) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   (PROJECT, "Fixture active", compact(active_canvas), STAMP, STAMP + 2, 3, None, FOLDER, None, None, 2))
        db.execute("INSERT INTO workflows(id,name,data,created_at,updated_at,version,deleted_at,folder_id,purged_at,cover_url,node_count) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   (TRASHED, "Fixture trashed", compact(trashed_canvas), STAMP, STAMP + 3, 2, STAMP + 3, None, None, None, 0))
        db.execute("INSERT INTO media_files VALUES(?,?,?,?,?,?)", ("fixture-media-inline", "image", None, base64.b64encode(MEDIA_BYTES).decode(), len(MEDIA_BYTES), STAMP))
        db.execute("INSERT INTO media_files VALUES(?,?,?,?,?,?)", ("fixture-media-oss", "video", media_url, None, len(EXTERNAL_MEDIA_BYTES), STAMP))
        db.execute("INSERT INTO canvas_save_receipts VALUES(?,?,?,?)", (PROJECT, "fixture-save-request", "fixture-save-digest", 3))
        db.execute("INSERT INTO canvas_deleted_nodes VALUES(?,?)", (PROJECT, "fixture-deleted-node"))
        for task_id, request_id, status, text, pipeline, output_saved, phase, revision in [
            (SCRIPT_DONE, "fixture-script-done", "completed", "Saved scene", None, 1, "completed", 4),
            (SCRIPT_RUNNING, "fixture-script-running", "running", "Scene plan", checkpoint, 0, "writing", 2),
        ]:
            db.execute("INSERT INTO script_tasks(id,request_id,canvas_id,node_id,input,status,text,pipeline,output_node_id,output_saved,phase,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (task_id, request_id, PROJECT, "fixture-script-node", script_input, status, text, pipeline, "fixture-text-node", output_saved, phase, revision, STAMP, STAMP + 4))
            db.execute("INSERT INTO script_requests VALUES(?,?,?,?,?)", (request_id, task_id, PROJECT, "fixture-script-node", script_input))
        for task in (done_task, waiting_task):
            db.execute("INSERT INTO agent_tasks VALUES(?,?,?,?)", (task["id"], PROJECT, task["status"], compact(task)))
        for message_id, task_id, text in ((MESSAGE_DONE, AGENT_DONE, "Create scene"), (MESSAGE_WAITING, AGENT_WAITING, "Generate video")):
            message = {"id": message_id, "taskId": task_id, "role": "user", "text": text, "references": [], "createdAt": STAMP}
            db.execute("INSERT INTO agent_messages VALUES(?,?,?,?)", (message_id, PROJECT, task_id, compact(message)))
        db.execute("INSERT INTO agent_receipts VALUES(?,?,?,?)", (PROJECT, "fixture-agent-request", "fixture-agent-digest", AGENT_WAITING))
        batch = {"id": "fixture-old-batch", "taskId": AGENT_WAITING, "projectId": PROJECT, "status": "pending", "items": []}
        db.execute("INSERT INTO agent_generation_batches VALUES(?,?,?)", (batch["id"], AGENT_WAITING, compact(batch)))
        db.execute("INSERT INTO agent_canvas_receipts VALUES(?,?,?,?)", (PROJECT, "fixture-agent-canvas", "fixture-canvas-digest", compact({"version": 3})))
        db.execute("INSERT INTO user_skills VALUES(?,?,?,?,?)", ("local-user-v1", "fixture-skill", "Fixture scene helper", "Write a concise scene.", STAMP))
        db.execute("INSERT INTO user_skill_resources VALUES(?,?,?,?)", ("local-user-v1", "fixture-skill", "assets/reference.bin", SKILL_BYTES))


def create_fixture(run_id, run_dir, media_url="https://fixture.invalid/fixture/video.mp4"):
    if not re.fullmatch(r"[a-z0-9]{6,32}", run_id):
        raise ValueError("run ID must be 6-32 lowercase letters or digits")
    run_dir = Path(run_dir)
    if run_dir.name != f"go-cutover-{run_id}" or run_dir.is_symlink() or run_dir.exists():
        raise ValueError("run directory must be new and named go-cutover-<run-id>")
    if not run_dir.parent.is_dir():
        raise ValueError("run directory parent must exist")
    run_dir.mkdir(mode=0o700)
    database = run_dir / "legacy.sqlite"
    exported = run_dir / "legacy-export.json"
    initialize_application_schema(database)
    seed(database, media_url)
    subprocess.run(["python3", str(Path(__file__).with_name("export_legacy_resources.py")), "--database", str(database), "--output", str(exported)], check=True)
    content = exported.read_bytes()
    payload = json.loads(content)
    subprocess.run(["go", "run", "./cmd/import-legacy-resources", "-file", str(exported)], cwd=ROOT / "apps/api", check=True)
    manifest = {
        "schemaVersion": payload["schemaVersion"],
        "exportSha256": hashlib.sha256(content).hexdigest(),
        "skillResourceSha256": hashlib.sha256(SKILL_BYTES).hexdigest(),
        "inlineMediaSha256": hashlib.sha256(MEDIA_BYTES).hexdigest(),
        "externalMediaSha256": hashlib.sha256(EXTERNAL_MEDIA_BYTES).hexdigest(),
        "counts": {key: len(value) for key, value in payload.items() if isinstance(value, list)},
        "ids": {key: sorted(str(row.get("id", row.get("name", row.get("request_id", "")))) for row in value)
                for key, value in payload.items() if isinstance(value, list)},
        "ossHost": "fixture.invalid",
    }
    manifest_path = run_dir / "fixture-manifest.json"
    with os.fdopen(os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(manifest, output, sort_keys=True, separators=(",", ":"))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--media-url", default="https://fixture.invalid/fixture/video.mp4")
    args = parser.parse_args()
    create_fixture(args.run_id, args.run_dir, args.media_url)


if __name__ == "__main__":
    main()
