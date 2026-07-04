#!/usr/bin/env python3
"""Pre-bake ("prewarm") SWE-bench task images with Node + the oxagen CLI.

For each requested task this script:

  1. locates the Harbor task package cached at
     ~/.cache/harbor/tasks/packages/swe-bench/<instance>/<contenthash>/
     (populated by a prior `./run.sh` / `harbor run` — this script does NOT
     download datasets);
  2. builds the task's environment/Dockerfile as-is into a local
     "taskbase" tag (oxagen-taskbase/<name>:<envhash12>), preserving any RUN
     steps the task Dockerfile adds on top of the swebench instance image;
  3. builds the overlay in prewarm/Dockerfile on top of that taskbase into
     oxagen-prewarmed/<name>:<envhash12>-<bundlesha12>, baking in Node 22,
     the oxagen bundle + wasm assets, the wrapper, static ripgrep, and the
     .bundle.sha256 marker the adapter uses to skip re-uploads.

At trial time, PrewarmedDockerEnvironment (src/oxagen_swe_bench/prewarm_env.py)
looks up the same tag and, when present, tells Harbor to run it directly as a
prebuilt image — collapsing the ~109s/task agent_setup to near-zero. See
PREWARM.md for the full story.

Usage (inside the bench venv):
    uv run --project bench/swe-bench python bench/swe-bench/prewarm.py \
        [--dry-run] [task-id ...]

Task ids may also come from OXAGEN_TASK_IDS or TASK_IDS (comma/space
separated). The bundle path defaults to apps/cli/dist-standalone/oxagen.mjs
and is overridable via OXAGEN_CLI_BUNDLE.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Runs inside the bench venv (uv run --project bench/swe-bench), so harbor and
# the editable oxagen_terminal_bench adapter are both importable.
from harbor.environments.definition import environment_content_hash
from oxagen_terminal_bench.oxagen_agent import _cached_rg_binary

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
OVERLAY_DOCKERFILE = SCRIPT_DIR / "prewarm" / "Dockerfile"
TASKS_CACHE = Path.home() / ".cache" / "harbor" / "tasks" / "packages" / "swe-bench"

TASKBASE_REPO_PREFIX = "oxagen-taskbase"
PREWARMED_REPO_PREFIX = "oxagen-prewarmed"

_FROM_RE = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)", re.IGNORECASE)


@dataclass
class TaskResult:
    task_id: str
    status: str  # "built" | "cached" | "skipped" | "dry-run"
    tag: str
    detail: str = ""


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _bundle_path() -> Path:
    override = os.environ.get("OXAGEN_CLI_BUNDLE")
    if override:
        p = Path(override).expanduser().resolve()
        if not p.is_file():
            sys.exit(f"OXAGEN_CLI_BUNDLE points at a missing file: {p}")
        return p
    candidate = REPO_ROOT / "apps" / "cli" / "dist-standalone" / "oxagen.mjs"
    if not candidate.is_file():
        sys.exit(
            "Oxagen bundle not found. Build it first:\n"
            "    pnpm --filter @oxagen/cli bundle\n"
            f"or set OXAGEN_CLI_BUNDLE=/abs/path/to/oxagen.mjs (looked for {candidate})"
        )
    return candidate


def _parse_first_from(dockerfile: Path) -> str | None:
    """Return the image ref of the first FROM line (handles --platform=...)."""
    for line in dockerfile.read_text().splitlines():
        m = _FROM_RE.match(line)
        if m:
            return m.group(1)
    return None


def _sanitize_image_name(image_ref: str) -> str:
    """Derive a valid docker repo name component from a base-image ref.

    e.g. 'swebench/sweb.eval.x86_64.django_1776_django-11099:latest'
      -> 'sweb.eval.x86_64.django_1776_django-11099'
    """
    name = image_ref.rsplit("/", 1)[-1]  # drop registry/namespace
    if ":" in name:
        name = name.rsplit(":", 1)[0]  # drop tag
    name = name.split("@", 1)[0]  # drop digest
    name = name.lower()
    name = re.sub(r"[^a-z0-9._-]+", "-", name)
    name = name.strip("._-") or "unknown-base"
    return name


def _docker_image_exists(tag: str) -> bool:
    result = subprocess.run(
        ["docker", "image", "inspect", tag],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def _docker_build(
    tag: str, context: Path, *, build_args: dict[str, str] | None = None,
    dockerfile: Path | None = None, platform: str | None = None,
) -> None:
    cmd = ["docker", "build", "-t", tag]
    if platform:
        cmd += ["--platform", platform]
    if dockerfile:
        cmd += ["-f", str(dockerfile)]
    for key, value in (build_args or {}).items():
        cmd += ["--build-arg", f"{key}={value}"]
    cmd.append(str(context))
    print(f"    $ {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


@contextlib.contextmanager
def _image_lock(tag: str):
    """Per-image advisory file lock so concurrent invocations don't double-build."""
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", tag)
    lock_path = Path(tempfile.gettempdir()) / f"oxagen-prewarm-{safe}.lock"
    with lock_path.open("w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def _stage_overlay_context(bundle: Path, bundle_sha: str, ctx: Path) -> None:
    """Populate a temp build context for prewarm/Dockerfile."""
    shutil.copy2(OVERLAY_DOCKERFILE, ctx / "Dockerfile")

    oxagen_dir = ctx / "oxagen"
    oxagen_dir.mkdir()
    shutil.copy2(bundle, oxagen_dir / "oxagen.mjs")
    for wasm in sorted(bundle.parent.glob("*.wasm")):
        shutil.copy2(wasm, oxagen_dir / wasm.name)
    (oxagen_dir / ".bundle.sha256").write_text(bundle_sha + "\n")

    # rg is an optimization, never a blocker: rgbin/ may legitimately be empty.
    rgbin_dir = ctx / "rgbin"
    rgbin_dir.mkdir()
    rg = _cached_rg_binary()
    if rg is not None:
        shutil.copy2(rg, rgbin_dir / "rg")
        (rgbin_dir / "rg").chmod(0o755)
    else:
        print("    (static ripgrep unavailable on host; baking image without rg)")


def prewarm_task(
    task_id: str, bundle: Path, bundle_sha: str, *, dry_run: bool
) -> list[TaskResult]:
    task_dir = TASKS_CACHE / task_id
    if not task_dir.is_dir():
        return [
            TaskResult(
                task_id,
                "skipped",
                "-",
                f"no cached task package at {task_dir} — run the bench once "
                "(./run.sh with this TASK_ID) so Harbor fetches the task, then re-run prewarm",
            )
        ]

    results: list[TaskResult] = []
    env_dirs = sorted(
        d / "environment"
        for d in task_dir.iterdir()
        if (d / "environment" / "Dockerfile").is_file()
    )
    if not env_dirs:
        return [
            TaskResult(
                task_id, "skipped", "-",
                f"no environment/Dockerfile under {task_dir} (unexpected package layout)",
            )
        ]

    for env_dir in env_dirs:
        env_hash = environment_content_hash(env_dir)[:12]
        from_image = _parse_first_from(env_dir / "Dockerfile")
        if not from_image:
            results.append(
                TaskResult(task_id, "skipped", "-", f"no FROM line in {env_dir}/Dockerfile")
            )
            continue
        name = _sanitize_image_name(from_image)
        taskbase_tag = f"{TASKBASE_REPO_PREFIX}/{name}:{env_hash}"
        prewarmed_tag = f"{PREWARMED_REPO_PREFIX}/{name}:{env_hash}-{bundle_sha[:12]}"
        # SWE-bench instance images are x86_64; pin the platform so the bake
        # matches what Harbor runs (and does not silently build arm64 on Macs).
        platform = "linux/amd64" if "x86_64" in from_image else None

        if _docker_image_exists(prewarmed_tag):
            results.append(TaskResult(task_id, "cached", prewarmed_tag))
            continue
        if dry_run:
            results.append(
                TaskResult(
                    task_id, "dry-run", prewarmed_tag,
                    f"would build taskbase {taskbase_tag} then overlay",
                )
            )
            continue

        try:
            with _image_lock(prewarmed_tag):
                if _docker_image_exists(prewarmed_tag):  # built while we waited
                    results.append(TaskResult(task_id, "cached", prewarmed_tag))
                    continue
                if not _docker_image_exists(taskbase_tag):
                    print(f"==> {task_id}: building taskbase {taskbase_tag}")
                    _docker_build(taskbase_tag, env_dir, platform=platform)
                else:
                    print(f"==> {task_id}: taskbase cached ({taskbase_tag})")
                print(f"==> {task_id}: building overlay {prewarmed_tag}")
                with tempfile.TemporaryDirectory(prefix="oxagen-prewarm-") as td:
                    ctx = Path(td)
                    _stage_overlay_context(bundle, bundle_sha, ctx)
                    _docker_build(
                        prewarmed_tag,
                        ctx,
                        build_args={"BASE_IMAGE": taskbase_tag},
                        platform=platform,
                    )
                results.append(TaskResult(task_id, "built", prewarmed_tag))
        except subprocess.CalledProcessError as exc:
            results.append(
                TaskResult(
                    task_id, "skipped", prewarmed_tag,
                    f"docker build failed (exit {exc.returncode}) — trial falls back to normal build",
                )
            )
        except Exception as exc:  # noqa: BLE001 — prewarm must never hard-fail a run
            results.append(
                TaskResult(task_id, "skipped", prewarmed_tag, f"{type(exc).__name__}: {exc}")
            )
    return results


def _resolve_task_ids(args_ids: list[str]) -> list[str]:
    raw = args_ids or re.split(
        r"[,\s]+",
        (os.environ.get("OXAGEN_TASK_IDS") or os.environ.get("TASK_IDS") or "").strip(),
    )
    seen: dict[str, None] = {}
    for t in raw:
        t = t.strip().lstrip("*")
        # Accept namespaced ids ("swe-bench/django__django-11099") too.
        t = t.rsplit("/", 1)[-1]
        if t:
            seen.setdefault(t)
    return list(seen)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("task_ids", nargs="*", help="SWE-bench instance ids (e.g. django__django-11099)")
    parser.add_argument("--dry-run", action="store_true", help="print what would build, build nothing")
    args = parser.parse_args()

    task_ids = _resolve_task_ids(args.task_ids)
    if not task_ids:
        parser.error("no task ids given (args, OXAGEN_TASK_IDS, or TASK_IDS)")

    if shutil.which("docker") is None:
        sys.exit("docker is not on PATH")

    bundle = _bundle_path()
    bundle_sha = _sha256_file(bundle)
    print(f"==> bundle: {bundle}")
    print(f"==> bundle sha256: {bundle_sha} (tag component {bundle_sha[:12]})")
    print(f"==> tasks: {' '.join(task_ids)}{'  [dry-run]' if args.dry_run else ''}")

    results: list[TaskResult] = []
    for task_id in task_ids:
        results.extend(prewarm_task(task_id, bundle, bundle_sha, dry_run=args.dry_run))

    print("\n==> prewarm summary")
    width = max(len(r.task_id) for r in results)
    for r in results:
        line = f"  {r.task_id:<{width}}  {r.status:<8}  {r.tag}"
        if r.detail:
            line += f"  ({r.detail})"
        print(line)

    # Non-zero only when NOTHING succeeded and something was requested — the
    # run.sh caller treats any failure as non-fatal anyway.
    ok = any(r.status in {"built", "cached", "dry-run"} for r in results)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
