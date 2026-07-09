"""Harbor DockerEnvironment that transparently runs pre-baked task images.

Selected via Harbor's custom-environment flag (wired by run.sh when
OXAGEN_PREWARMED=1):

    harbor run --env oxagen_swe_bench.prewarm_env:PrewarmedDockerEnvironment ...

When the expected prewarmed image (built by bench/swe-bench/prewarm.py) is
present locally, this subclass sets ``task_env_config.docker_image`` so
Harbor's ``should_use_prebuilt_docker_image()`` check skips the per-trial
image build entirely and runs the pre-baked image directly — collapsing the
~109s/task agent_setup (Node install + bundle upload) to near-zero. The
adapter's ``.bundle.sha256`` fast-path (oxagen_agent.py) then skips the
bundle/wasm re-upload too.

Tag scheme (must stay in lockstep with prewarm.py):

    oxagen-prewarmed/<name>:<environment_id[:12]>-<bundle_sha[:12]>

  - <name>            sanitized from the first FROM line of the task's
                      environment/Dockerfile
  - environment_id    Harbor's content hash of the environment/ dir — any
                      change to the task's Dockerfile invalidates the tag
  - bundle_sha        sha256 of the oxagen CLI bundle, from OXAGEN_BUNDLE_SHA256
                      (exported by run.sh) — a rebuilt bundle invalidates the tag

Everything here is defensive: any missing image, unset var, or exception
falls back to Harbor's normal build path with at most a one-line log — a
prewarm problem must never fail a trial.
"""

from __future__ import annotations

import os
import re
import subprocess

from harbor.environments.docker.docker import DockerEnvironment

_PREWARMED_REPO_PREFIX = "oxagen-prewarmed"

_FROM_RE = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)", re.IGNORECASE)


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _parse_first_from(dockerfile_text: str) -> str | None:
    for line in dockerfile_text.splitlines():
        m = _FROM_RE.match(line)
        if m:
            return m.group(1)
    return None


def _sanitize_image_name(image_ref: str) -> str:
    """Mirror prewarm.py's name derivation (keep in lockstep)."""
    name = image_ref.rsplit("/", 1)[-1]
    if ":" in name:
        name = name.rsplit(":", 1)[0]
    name = name.split("@", 1)[0]
    name = name.lower()
    name = re.sub(r"[^a-z0-9._-]+", "-", name)
    name = name.strip("._-") or "unknown-base"
    return name


def _image_exists(tag: str) -> bool:
    return (
        subprocess.run(
            ["docker", "image", "inspect", tag],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        ).returncode
        == 0
    )


def _matching_tags(repo: str, env12: str) -> list[str]:
    """Local tags of ``repo`` whose tag starts with ``<env12>-``."""
    result = subprocess.run(
        ["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", repo],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        return []
    return [
        line.strip()
        for line in result.stdout.splitlines()
        if line.strip() and line.strip().rsplit(":", 1)[-1].startswith(f"{env12}-")
    ]


class PrewarmedDockerEnvironment(DockerEnvironment):
    """DockerEnvironment that opts into a local pre-baked image when present."""

    def _maybe_override_task_env_config(self) -> None:
        super()._maybe_override_task_env_config()
        try:
            self._maybe_use_prewarmed_image()
        except Exception as exc:  # noqa: BLE001 — never fail a trial over prewarm
            self.logger.warning(
                "oxagen-prewarm: lookup failed (%s: %s); falling back to normal build",
                type(exc).__name__,
                exc,
            )

    def _maybe_use_prewarmed_image(self) -> None:
        if not _is_truthy(os.environ.get("OXAGEN_PREWARMED")):
            return
        if self.task_env_config.docker_image:
            return  # task already pins a prebuilt image — respect it

        dockerfile = self.environment_dir / "Dockerfile"
        if not dockerfile.is_file():
            return
        from_image = _parse_first_from(dockerfile.read_text())
        if not from_image:
            return

        name = _sanitize_image_name(from_image)
        repo = f"{_PREWARMED_REPO_PREFIX}/{name}"
        # NOTE: read environment_id BEFORE mutating docker_image — it is a
        # cached_property, so accessing it here pins the pre-override value
        # (identical to what prewarm.py computes from the environment/ dir).
        env12 = self.environment_id[:12]

        bundle_sha = (os.environ.get("OXAGEN_BUNDLE_SHA256") or "").strip().lower()
        if bundle_sha:
            tag = f"{repo}:{env12}-{bundle_sha[:12]}"
            if not _image_exists(tag):
                self.logger.info(
                    "oxagen-prewarm: image %s not found locally; using normal build "
                    "(run bench/swe-bench/prewarm.py to bake it)",
                    tag,
                )
                return
        else:
            # No bundle sha exported: only trust the env-hash prefix when it
            # matches exactly one local tag — ambiguity means we cannot know
            # which bundle is baked in, so build normally.
            candidates = _matching_tags(repo, env12)
            if len(candidates) != 1:
                self.logger.info(
                    "oxagen-prewarm: OXAGEN_BUNDLE_SHA256 unset and %d local tags match "
                    "%s:%s-*; using normal build",
                    len(candidates),
                    repo,
                    env12,
                )
                return
            tag = candidates[0]

        self.task_env_config.docker_image = tag
        self.logger.info("oxagen-prewarm: using pre-baked image %s", tag)
