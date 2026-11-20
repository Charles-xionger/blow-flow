import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("rehearse_go_cutover", Path(__file__).with_name("rehearse_go_cutover.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IsolationTest(unittest.TestCase):
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
