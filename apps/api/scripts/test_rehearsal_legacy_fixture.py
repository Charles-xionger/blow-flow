import json
import hashlib
import base64
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("rehearsal_legacy_fixture.py")


class FixtureTest(unittest.TestCase):
    def test_disposable_fixture_exports_and_validates_all_resource_kinds(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary) / "go-cutover-test123"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--run-id", "test123", "--run-dir", str(run_dir)],
                text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((run_dir / "fixture-manifest.json").read_text())
            export = json.loads((run_dir / "legacy-export.json").read_text())
            self.assertEqual(manifest["counts"], {key: len(value) for key, value in export.items() if isinstance(value, list)})
            self.assertEqual(len(export["projects"]), 2)
            self.assertEqual(len(export["scriptTasks"]), 2)
            self.assertEqual(len(export["agentTasks"]), 2)
            self.assertEqual(len(export["userSkillResources"]), 1)
            self.assertEqual(export["userSkills"][0]["owner_id"], "local-user-v1")
            self.assertEqual({row["status"] for row in export["agentTasks"]}, {"completed", "waiting"})
            self.assertEqual({row["status"] for row in export["scriptTasks"]}, {"completed", "running"})
            self.assertEqual({row["id"] for row in export["projects"]}, {"fixture-project-active", "fixture-project-trashed"})
            active = next(row for row in export["projects"] if row["id"] == "fixture-project-active")
            self.assertEqual(active["version"], 3)
            self.assertEqual(json.loads(active["data"])["edges"][0]["id"], "fixture-edge")
            resource = base64.b64decode(export["userSkillResources"][0]["content_base64"])
            self.assertEqual(hashlib.sha256(resource).hexdigest(), manifest["skillResourceSha256"])
            oss_media = next(row for row in export["mediaFiles"] if row["id"] == "fixture-media-oss")
            self.assertEqual(oss_media["url"], "https://fixture.invalid/fixture/video.mp4")
            self.assertEqual(manifest["externalMediaSha256"], hashlib.sha256(b"\x00\x00\x00\x18ftypmp42fixture-video").hexdigest())
            self.assertIn("dry run; PostgreSQL unchanged", result.stdout)
            self.assertEqual(os.stat(run_dir / "legacy-export.json").st_mode & 0o777, 0o600)
            self.assertNotIn("content_base64", (run_dir / "fixture-manifest.json").read_text())

    def test_refuses_existing_or_unsafe_run_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "go-cutover-test123"
            path.mkdir()
            result = subprocess.run([sys.executable, str(SCRIPT), "--run-id", "test123", "--run-dir", str(path)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            unsafe = subprocess.run([sys.executable, str(SCRIPT), "--run-id", "test123", "--run-dir", temporary], capture_output=True)
            self.assertNotEqual(unsafe.returncode, 0)


if __name__ == "__main__":
    unittest.main()
