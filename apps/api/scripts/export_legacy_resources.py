#!/usr/bin/env python3
"""Read-only, consistent SQLite export for the Go resource import command.

Stop Next.js writers before running. The export includes no platform credentials.
"""

import argparse
import json
import os
import sqlite3
from pathlib import Path


def rows(db, table):
    exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return [dict(row) for row in db.execute(f"SELECT * FROM {table}")] if exists else []


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
        payload = {
            "schemaVersion": 1,
            "projects": rows(db, "workflows"),
            "folders": rows(db, "project_folders"),
            "mediaFiles": rows(db, "media_files"),
            "saveReceipts": rows(db, "canvas_save_receipts"),
            "deletedNodes": rows(db, "canvas_deleted_nodes"),
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
