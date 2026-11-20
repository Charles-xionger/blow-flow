import importlib.util
import hashlib
import base64
import sqlite3
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("rehearse_go_cutover", Path(__file__).with_name("rehearse_go_cutover.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IsolationTest(unittest.TestCase):
    def test_rollback_entry_reopens_legacy_read_only_and_excludes_go_delta(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "legacy.sqlite"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE workflows(id TEXT PRIMARY KEY, data TEXT)")
                connection.execute("INSERT INTO workflows VALUES('legacy-project', '{}')")
            restored = module.restore_legacy_read_entry(database, ["legacy-project"], ["go-project"])
            self.assertEqual(restored["legacyProjectIds"], ["legacy-project"])
            self.assertEqual(restored["goOnlyProjectIdsVisible"], [])

    def test_external_media_bytes_are_fetched_and_checked(self):
        inline = b"\x89PNG\r\n\x1a\nfixture"
        video = b"\x00\x00\x00\x18ftypmp42fixture-video"
        manifest = {"inlineMediaSha256": hashlib.sha256(inline).hexdigest(),
                    "externalMediaSha256": hashlib.sha256(video).hexdigest()}
        inline_url = "data:image/png;base64," + base64.b64encode(inline).decode()
        with module.external_media_fixture() as url:
            self.assertTrue(module.verify_imported_media(inline_url, url, url, manifest))
            self.assertFalse(module.verify_imported_media(inline_url, url, url, {**manifest, "externalMediaSha256": "0" * 64}))
            self.assertFalse(module.verify_imported_media(inline_url, url, url + "?other", manifest))

    def test_accepts_only_run_specific_project_volumes_and_ports(self):
        run_id = "rehearsal_012345abcdef"
        env = {"COMPOSE_PROJECT_NAME": run_id, "POSTGRES_VOLUME_NAME": run_id + "_postgres",
               "RABBITMQ_VOLUME_NAME": run_id + "_rabbit", "POSTGRES_PORT": "49101",
               "REDIS_PORT": "49102", "RABBITMQ_PORT": "49103", "RABBITMQ_MANAGEMENT_PORT": "49104"}
        module.validate_identity(run_id, env)
        for key, value in (("COMPOSE_PROJECT_NAME", "ai-flow"), ("POSTGRES_VOLUME_NAME", "ai-flow_postgres-data"),
                           ("RABBITMQ_VOLUME_NAME", "ai-flow_rabbitmq-data"), ("POSTGRES_PORT", "5432")):
            changed = env.copy()
            changed[key] = value
            with self.assertRaises(ValueError, msg=key):
                module.validate_identity(run_id, changed)
        with self.assertRaises(ValueError):
            module.validate_identity("ai-flow", env)


if __name__ == "__main__":
    unittest.main()
