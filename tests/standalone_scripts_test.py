import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    path = ROOT / ".github" / "scripts" / name
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


standalone = load_script("introspect_standalone_plugins.py")
merge_schemas = load_script("merge_schemas.py")


class EnvFileSelectionTests(unittest.TestCase):
    def test_discovers_legacy_qiime2_and_current_rachis_env_names(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            legacy = env_dir / "q2-test-qiime2-amplicon-2025.10.yml"
            current = env_dir / "q2-test-rachis-qiime2-2026.4.yml"
            legacy.touch()
            current.touch()

            candidates = standalone.discover_env_files(env_dir)

            self.assertEqual(
                [(candidate.path.name, candidate.ecosystem, candidate.distribution) for candidate in candidates],
                [
                    (legacy.name, "qiime2", "amplicon"),
                    (current.name, "rachis", "qiime2"),
                ],
            )

    def test_selects_exact_requested_release_by_default(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "q2-test-qiime2-amplicon-2026.1.yml").touch()
            (env_dir / "q2-test-rachis-qiime2-2026.4.yml").touch()
            (env_dir / "q2-test-rachis-qiime2-2026.10.yml").touch()

            selected = standalone.select_env_file(env_dir, "2026.4")

            self.assertEqual(selected.path.name, "q2-test-rachis-qiime2-2026.4.yml")

    def test_exact_requested_returns_none_without_matching_release(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "q2-test-qiime2-amplicon-2026.1.yml").touch()
            (env_dir / "q2-test-rachis-qiime2-2026.10.yml").touch()

            self.assertIsNone(standalone.select_env_file(env_dir, "2026.4"))

    def test_latest_selection_remains_available_for_local_use(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "q2-test-qiime2-amplicon-0.9.0.yml").touch()
            (env_dir / "q2-test-qiime2-amplicon-2.0.0.yml").touch()
            (env_dir / "q2-test-rachis-qiime2-10.1.0.yml").touch()

            selected = standalone.select_env_file(env_dir, selection="latest")

            self.assertEqual(selected.path.name, "q2-test-rachis-qiime2-10.1.0.yml")

    def test_can_select_latest_version_less_than_or_equal_to_requested(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "q2-test-qiime2-amplicon-2025.10.yml").touch()
            (env_dir / "q2-test-qiime2-amplicon-2026.1.yml").touch()
            (env_dir / "q2-test-qiime2-amplicon-2026.4.yml").touch()

            selected = standalone.select_env_file(env_dir, "2026.1", "latest_lte_requested")

            self.assertEqual(selected.path.name, "q2-test-qiime2-amplicon-2026.1.yml")

    def test_prefers_tiny_for_same_version(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "q2-test-rachis-qiime2-2026.4.yml").touch()
            (env_dir / "q2-test-rachis-moshpit-2026.4.yml").touch()
            (env_dir / "q2-test-rachis-tiny-2026.4.yml").touch()

            selected = standalone.select_env_file(env_dir, "2026.4")

            self.assertEqual(selected.path.name, "q2-test-rachis-tiny-2026.4.yml")

    def test_amplicon_and_qiime2_have_the_same_distribution_priority(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "q2-test-qiime2-amplicon-2025.10.yml").touch()
            (env_dir / "q2-test-qiime2-moshpit-2025.10.yml").touch()

            legacy = standalone.select_env_file(env_dir, "2025.10")

            self.assertEqual(legacy.path.name, "q2-test-qiime2-amplicon-2025.10.yml")

        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "q2-test-rachis-qiime2-2026.4.yml").touch()
            (env_dir / "q2-test-rachis-moshpit-2026.4.yml").touch()

            current = standalone.select_env_file(env_dir, "2026.4")

            self.assertEqual(current.path.name, "q2-test-rachis-qiime2-2026.4.yml")

    def test_ignores_non_matching_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "README.md").touch()
            (env_dir / "q2-test-dev.yml").touch()
            (env_dir / "q2-test-qiime2-tiny-2025.10.yaml").touch()

            selected = standalone.select_env_file(env_dir, "2025.10")

            self.assertEqual(selected.path.name, "q2-test-qiime2-tiny-2025.10.yaml")

    def test_returns_none_when_all_env_files_are_newer(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_dir = Path(tmpdir)
            (env_dir / "q2-test-qiime2-tiny-2026.4.yml").touch()

            self.assertIsNone(standalone.select_env_file(env_dir, "2026.1", "latest_lte_requested"))


class MergeSchemasTests(unittest.TestCase):
    def test_standalone_duplicate_plugins_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            official = tmp / "official.json"
            standalone_json = tmp / "standalone.json"
            output = tmp / "schema.json"

            official.write_text(json.dumps({
                "deseq2": {"actions": {"official_action": {}}, "types": {"OfficialType": ""}},
                "other": {"actions": {}, "types": {}},
            }))
            standalone_json.write_text(json.dumps({
                "deseq2": {"actions": {"standalone_action": {}}, "types": {"StandaloneType": ""}},
                "external": {"actions": {}, "types": {"ExternalType": ""}},
            }))

            merge_schemas.merge_schemas(
                {"qiime2": str(official), "standalone": str(standalone_json)},
                str(output),
            )

            schema = json.loads(output.read_text())
            self.assertEqual(schema["distributions"]["standalone"]["plugins"], ["external"])
            self.assertEqual(list(schema["plugins"]["deseq2"]["actions"]), ["official_action"])
            self.assertIn("external", schema["plugins"])
            self.assertIn("ExternalType", schema["types"])

    def test_equivalent_input_orders_produce_identical_schema_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            first_input = tmp / "first.json"
            second_input = tmp / "second.json"
            first_output = tmp / "first-schema.json"
            second_output = tmp / "second-schema.json"

            first_input.write_text(json.dumps({
                "zeta": {
                    "actions": {
                        "last": {"outputs": {"z": {"type": ["Z"]}}},
                        "first": {"outputs": {"a": {"type": ["A"]}}},
                    },
                    "types": {"ZType": "", "AType": ""},
                },
                "alpha": {"actions": {}, "types": {}},
            }))
            second_input.write_text(json.dumps({
                "alpha": {"types": {}, "actions": {}},
                "zeta": {
                    "types": {"AType": "", "ZType": ""},
                    "actions": {
                        "first": {"outputs": {"a": {"type": ["A"]}}},
                        "last": {"outputs": {"z": {"type": ["Z"]}}},
                    },
                },
            }))

            merge_schemas.merge_schemas({"test": str(first_input)}, str(first_output))
            merge_schemas.merge_schemas({"test": str(second_input)}, str(second_output))

            self.assertEqual(first_output.read_bytes(), second_output.read_bytes())
            schema = json.loads(first_output.read_text())
            self.assertEqual(schema["distributions"]["test"]["plugins"], ["alpha", "zeta"])


class ArtifactCombineTests(unittest.TestCase):
    def test_combines_plugin_json_without_treating_summary_as_schema(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            artifact = root / "standalone-example"
            artifact.mkdir()
            (artifact / "standalone-example.json").write_text(json.dumps({
                "example": {"actions": {}, "types": {}},
            }))
            (artifact / "standalone-example.summary.json").write_text(json.dumps({
                "name": "example",
                "status": "success",
                "detail": "ok",
            }))

            output = root / "standalone.json"
            summary = root / "summary.md"
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / ".github" / "scripts" / "introspect_standalone_plugins.py"),
                    "--version",
                    "2026.4",
                    "--combine-artifacts",
                    str(root),
                    "--output",
                    str(output),
                    "--summary",
                    str(summary),
                ],
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(set(json.loads(output.read_text())), {"example"})
            self.assertIn("| `example` | success | ok |", summary.read_text())


class IntrospectPluginsCliTests(unittest.TestCase):
    def write_fake_qiime2(self, root):
        package = root / "qiime2"
        package.mkdir()
        (package / "__init__.py").write_text("")
        (package / "sdk.py").write_text(
            """
class Field:
    def __init__(self, qiime_type, has_default=False):
        self.qiime_type = qiime_type
        self._has_default = has_default

    def has_default(self):
        return self._has_default


class Type:
    def __init__(self, name):
        self.name = name

    def __str__(self):
        return self.name


class Union:
    members = [Type("ZType"), Type("AType")]

    def __str__(self):
        return "ZType | AType"


class Signature:
    inputs = {"table": Field(Union())}
    parameters = {"threads": Field("Int", True)}
    outputs = {"result": Field("FeatureTable[Frequency]")}


class Action:
    description = "Run the action."
    signature = Signature()


class Plugin:
    actions = {"run": Action()}
    types = {}


class PluginManager:
    def __init__(self):
        self.plugins = {"target": Plugin(), "extra": Plugin()}
"""
        )

    def run_introspect(self, fake_root, *args):
        env = os.environ.copy()
        env["PYTHONPATH"] = str(fake_root)
        return subprocess.run(
            [sys.executable, str(ROOT / ".github" / "scripts" / "introspect_plugins.py"), *args],
            text=True,
            capture_output=True,
            env=env,
        )

    def test_only_returns_exact_requested_plugin(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            fake_root = Path(tmpdir)
            self.write_fake_qiime2(fake_root)

            result = self.run_introspect(fake_root, "--only", "target")

            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(set(data), {"target"})
            self.assertEqual(
                data["target"]["actions"]["run"]["inputs"]["table"]["type"],
                ["AType", "ZType"],
            )

    def test_only_exits_nonzero_when_plugin_is_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            fake_root = Path(tmpdir)
            self.write_fake_qiime2(fake_root)

            result = self.run_introspect(fake_root, "--only", "missing")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Plugin 'missing' not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
