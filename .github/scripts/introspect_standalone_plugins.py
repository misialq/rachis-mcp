import argparse
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


DISTRIBUTION_PRIORITY = {
    "tiny": 0,
    "amplicon": 1,
    "qiime2": 1,
    "moshpit": 2,
    "pathogenome": 3,
}
ENV_FILE_RE = re.compile(
    r"^(?P<prefix>.+)-(?P<ecosystem>qiime2|rachis)-"
    r"(?P<distribution>[A-Za-z0-9_-]+)-(?P<version>\d+(?:\.\d+)*)\.ya?ml$"
)


@dataclass(frozen=True)
class EnvFileCandidate:
    path: Path
    version: tuple[int, ...]
    ecosystem: str
    distribution: str


def parse_version(version: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in version.split("."))
    except ValueError as e:
        raise ValueError(f"Invalid version '{version}'. Expected numeric dot-separated version.") from e


def discover_env_files(env_dir: Path) -> list[EnvFileCandidate]:
    candidates = []
    if not env_dir.exists():
        return candidates

    for path in sorted(env_dir.iterdir()):
        if not path.is_file():
            continue
        match = ENV_FILE_RE.match(path.name)
        if not match:
            continue
        candidates.append(
            EnvFileCandidate(
                path=path,
                version=parse_version(match.group("version")),
                ecosystem=match.group("ecosystem").lower(),
                distribution=match.group("distribution").lower(),
            )
        )
    return candidates


def select_env_file(
    env_dir: Path,
    requested_version: str | None = None,
    selection: str = "latest",
) -> EnvFileCandidate | None:
    candidates = discover_env_files(env_dir)
    if selection == "latest_lte_requested":
        if requested_version is None:
            raise ValueError("requested_version is required for latest_lte_requested env selection.")
        requested = parse_version(requested_version)
        candidates = [candidate for candidate in candidates if candidate.version <= requested]
    elif selection != "latest":
        raise ValueError(f"Unsupported env selection strategy '{selection}'.")

    if not candidates:
        return None

    def sort_key(candidate: EnvFileCandidate) -> tuple[tuple[int, ...], int, str]:
        distro_rank = DISTRIBUTION_PRIORITY.get(
            candidate.distribution,
            len(DISTRIBUTION_PRIORITY),
        )
        return (candidate.version, -distro_rank, candidate.path.name)

    return max(candidates, key=sort_key)


def run(cmd: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess:
    print(f"+ {' '.join(cmd)}", file=sys.stderr)
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)


def clone_repo(repo: str, ref: str, destination: Path) -> bool:
    clone = run(["git", "clone", "--depth", "1", "--branch", ref, repo, str(destination)])
    if clone.returncode == 0:
        return True

    print(clone.stderr, file=sys.stderr)
    fallback = run(["git", "clone", repo, str(destination)])
    if fallback.returncode != 0:
        print(fallback.stderr, file=sys.stderr)
        return False

    checkout = run(["git", "checkout", ref], cwd=destination)
    if checkout.returncode != 0:
        print(checkout.stderr, file=sys.stderr)
        return False
    return True


def load_manifest(path: Path) -> list[dict]:
    with path.open() as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("Standalone plugin manifest must be a JSON array.")
    return data


def write_summary(path: Path, rows: list[dict]) -> None:
    lines = [
        "### Standalone Plugins",
        "| Plugin | Status | Detail |",
        "|---|---|---|",
    ]
    for row in rows:
        lines.append(f"| `{row['name']}` | {row['status']} | {row['detail']} |")
    path.write_text("\n".join(lines) + "\n")


def introspect_plugin(
    plugin: dict,
    *,
    requested_version: str,
    workspace: Path,
    introspect_script: Path,
) -> tuple[dict, dict]:
    name = plugin.get("name")
    repo = plugin.get("repo")
    ref = plugin.get("ref", "main")
    env_dir_name = plugin.get("env_dir", "environment-files")
    env_selection = plugin.get("env_selection", "latest")

    if not name or not repo:
        return {}, {"name": name or "<unknown>", "status": "warning", "detail": "Missing name or repo"}

    checkout_dir = workspace / name
    if not clone_repo(repo, ref, checkout_dir):
        return {}, {"name": name, "status": "warning", "detail": f"Could not clone `{repo}` at `{ref}`"}

    env_candidate = select_env_file(checkout_dir / env_dir_name, requested_version, env_selection)
    if env_candidate is None:
        detail = "No env file found"
        if env_selection == "latest_lte_requested":
            detail = f"No env file found for version <= `{requested_version}`"
        return {}, {
            "name": name,
            "status": "warning",
            "detail": detail,
        }

    env_name = f"rachis-standalone-{re.sub(r'[^A-Za-z0-9_-]+', '-', name)}"
    create = run(["micromamba", "create", "-y", "-n", env_name, "-f", str(env_candidate.path)])
    if create.returncode != 0:
        print(create.stdout, file=sys.stderr)
        print(create.stderr, file=sys.stderr)
        return {}, {
            "name": name,
            "status": "warning",
            "detail": f"Environment creation failed for `{env_candidate.path.name}`",
        }

    try:
        introspect = run(
            [
                "micromamba",
                "run",
                "-n",
                env_name,
                "python",
                str(introspect_script),
                "--only",
                name,
            ]
        )
        if introspect.returncode != 0:
            print(introspect.stdout, file=sys.stderr)
            print(introspect.stderr, file=sys.stderr)
            return {}, {"name": name, "status": "warning", "detail": "Introspection failed"}

        data = json.loads(introspect.stdout)
        if set(data) != {name}:
            return {}, {"name": name, "status": "warning", "detail": "Introspection returned unexpected plugins"}

        version = ".".join(str(part) for part in env_candidate.version)
        return data, {
            "name": name,
            "status": "success",
            "detail": (
                f"`{env_candidate.path.name}` "
                f"({env_candidate.ecosystem}, {env_candidate.distribution}, {version})"
            ),
        }
    finally:
        remove = run(["micromamba", "env", "remove", "-y", "-n", env_name])
        if remove.returncode != 0:
            print(remove.stderr, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="Introspect configured standalone QIIME 2 plugins.")
    parser.add_argument("--version", required=True, help="Requested Rachis/QIIME 2 schema version.")
    parser.add_argument("--manifest", default=".github/standalone-plugins.json")
    parser.add_argument("--plugin-name")
    parser.add_argument("--repo")
    parser.add_argument("--ref", default="main")
    parser.add_argument("--env-dir", default="environment-files")
    parser.add_argument("--env-selection", default="latest", choices=["latest", "latest_lte_requested"])
    parser.add_argument("--combine-artifacts")
    parser.add_argument("--output", default="standalone.json")
    parser.add_argument("--summary", default="standalone-summary.md")
    args = parser.parse_args()

    output_path = Path(args.output)
    summary_path = Path(args.summary)
    introspect_script = Path(__file__).with_name("introspect_plugins.py").resolve()

    rows = []
    merged = {}

    if args.combine_artifacts:
        artifact_root = Path(args.combine_artifacts)
        for output in sorted(artifact_root.glob("**/standalone-*.json")):
            if output.name.endswith(".summary.json"):
                continue
            try:
                with output.open() as f:
                    merged.update(json.load(f))
            except Exception as e:
                rows.append({"name": output.stem, "status": "warning", "detail": str(e).replace("|", "\\|")})

        for summary in sorted(artifact_root.glob("**/standalone-*.summary.json")):
            try:
                with summary.open() as f:
                    rows.append(json.load(f))
            except Exception as e:
                rows.append({"name": summary.stem, "status": "warning", "detail": str(e).replace("|", "\\|")})
    elif args.plugin_name or args.repo:
        plugin = {
            "name": args.plugin_name,
            "repo": args.repo,
            "ref": args.ref,
            "env_dir": args.env_dir,
            "env_selection": args.env_selection,
        }
        with tempfile.TemporaryDirectory(prefix="rachis-standalone-") as tmpdir:
            data, row = introspect_plugin(
                plugin,
                requested_version=args.version,
                workspace=Path(tmpdir),
                introspect_script=introspect_script,
            )
            merged.update(data)
            rows.append(row)
    else:
        manifest_path = Path(args.manifest)
        if not manifest_path.exists():
            rows.append({"name": "standalone", "status": "warning", "detail": "Manifest not found"})
        else:
            with tempfile.TemporaryDirectory(prefix="rachis-standalone-") as tmpdir:
                workspace = Path(tmpdir)
                for plugin in load_manifest(manifest_path):
                    try:
                        data, row = introspect_plugin(
                            plugin,
                            requested_version=args.version,
                            workspace=workspace,
                            introspect_script=introspect_script,
                        )
                        merged.update(data)
                        rows.append(row)
                    except Exception as e:
                        rows.append({
                            "name": plugin.get("name", "<unknown>"),
                            "status": "warning",
                            "detail": str(e).replace("|", "\\|"),
                        })

    if merged:
        output_path.write_text(json.dumps(merged, indent=2) + "\n")
    elif output_path.exists():
        output_path.unlink()

    write_summary(summary_path, rows)
    if args.plugin_name and rows:
        Path(f"standalone-{args.plugin_name}.summary.json").write_text(json.dumps(rows[0], indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
