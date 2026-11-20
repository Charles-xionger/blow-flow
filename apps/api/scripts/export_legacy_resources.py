#!/usr/bin/env python3
"""Read-only, consistent SQLite export for the Go resource import command.

Stop Next.js writers before running. The export includes no platform credentials.
"""

import argparse
import base64
import json
import os
import sqlite3
from pathlib import Path


def rows(db, table):
    return [dict(row) for row in db.execute(f"SELECT * FROM {table}")]


def skill_rows(db, present):
    if "user_skills" not in present:
        return [], []
    columns = {row[1] for row in db.execute("PRAGMA table_info(user_skills)")}
    owner = "owner_id" if "owner_id" in columns else "'local-user-v1' AS owner_id"
    skills = [dict(row) for row in db.execute(f"SELECT {owner},name,description,instructions,created_at FROM user_skills ORDER BY name")]
    resources = []
    if "user_skill_resources" in present:
        columns = {row[1] for row in db.execute("PRAGMA table_info(user_skill_resources)")}
        resource_owner = "owner_id" if "owner_id" in columns else "'local-user-v1' AS owner_id"
        for row in db.execute(f"SELECT {resource_owner},skill_name,path,content FROM user_skill_resources ORDER BY skill_name,path"):
            value = dict(row)
            value["content_base64"] = base64.b64encode(value.pop("content")).decode("ascii")
            resources.append(value)
    return skills, resources


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists; refusing to overwrite an export")
    db = sqlite3.connect(f"file:{args.database.resolve()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute("BEGIN")
        required = {"workflows", "project_folders", "media_files", "canvas_save_receipts", "canvas_deleted_nodes"}
        present = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = sorted(required - present)
        if missing:
            parser.error("legacy database is missing required tables: " + ", ".join(missing))
        skills, skill_resources = skill_rows(db, present)
        payload = {
            "schemaVersion": 1,
            "userSkills": skills,
            "userSkillResources": skill_resources,
            "projects": rows(db, "workflows"),
            "folders": rows(db, "project_folders"),
            "mediaFiles": rows(db, "media_files"),
            "saveReceipts": rows(db, "canvas_save_receipts"),
            "deletedNodes": rows(db, "canvas_deleted_nodes"),
            "scriptTasks": rows(db, "script_tasks") if "script_tasks" in present else [],
            "scriptRequests": rows(db, "script_requests") if "script_requests" in present else [],
            "agentTasks": rows(db, "agent_tasks") if "agent_tasks" in present else [],
            "agentMessages": rows(db, "agent_messages") if "agent_messages" in present else [],
            "agentReceipts": rows(db, "agent_receipts") if "agent_receipts" in present else [],
            "agentGenerationBatches": rows(db, "agent_generation_batches") if "agent_generation_batches" in present else [],
            "agentCanvasReceipts": rows(db, "agent_canvas_receipts") if "agent_canvas_receipts" in present else [],
        }
        db.execute("COMMIT")
    finally:
        db.close()
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
    print("Exported:", {key: len(value) for key, value in payload.items() if isinstance(value, list)})


if __name__ == "__main__":
    main()
