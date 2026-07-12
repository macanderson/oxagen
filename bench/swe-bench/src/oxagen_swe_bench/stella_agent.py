"""Harbor agent adapter for the Stella (Rust) coding CLI.

Implements Harbor's ``BaseInstalledAgent`` so the ``stella`` agent can be
benchmarked on SWE-bench (and any Harbor dataset) head-to-head with Claude Code,
Codex CLI, and the TS Oxagen CLI.

How it works
------------
Stella is a standalone Rust binary (no Node runtime needed). This adapter
uploads the binary to the task container, installs it at ``/usr/local/bin/stella``,
and runs the agent headlessly in the task working directory with
``--output-format stream-json`` (one JSON line per AgentEvent).

Model selection
---------------
Harbor passes ``-m <provider>/<model>`` which maps directly to stella's
``--model`` flag (e.g. ``zai/glm-5.2``, ``anthropic/claude-fable-5``, etc.).
Stella talks directly to providers (BYOK) — no AI Gateway indirection.

Environment
-----------
``STELLA_API_KEY`` (required for most providers) — forwarded into the container.
``STELLA_MODEL`` — override the worker model (takes precedence over ``-m``).
``STELLA_BUDGET`` — per-task USD spend cap (enforced mode).
``STELLA_OUTPUT_FORMAT`` — fixed to ``stream-json`` for headless runs.
Any other ``STELLA_*`` var is forwarded verbatim.

Differences from oxagen_agent.py
----------------------------------
- No Node runtime installation (single static binary)
- No bundle/WASM upload (self-contained)
- No ``oxagen init`` pre-build (graph built on-demand by stella)
- Commands: ``stella run`` instead of ``oxagen --mode bypass``
- Output: ``AgentEvent`` JSONL (stable protocol) instead of ad-hoc text parsing
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# In-container locations.
_BINARY_REMOTE_TMP = "/tmp/stella"
_BINARY_INSTALL_PATH = "/usr/local/bin/stella"

# Default budget for a single task (USD). Unset = no cap.
_DEFAULT_TASK_BUDGET_USD = 3.0


def _locate_binary() -> Path:
    """Resolve the path to the stella binary on the host."""
    override = os.environ.get("STELLA_BINARY")
    if override:
        p = Path(override).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"STELLA_BINARY points at a missing file: {p}")
        return p

    # Editable install (`uv pip install -e .`) keeps __file__ inside the repo:
    # .../bench/swe-bench/src/oxagen_swe_bench/stella_agent.py
    # repo root is parents[5].
    repo_root = Path(__file__).resolve().parents[5]
    candidate = repo_root / "crates" / "target" / "release" / "stella"
    if candidate.is_file():
        return candidate

    raise FileNotFoundError(
        "Could not find the stella binary.\n"
        "Build it first:\n"
        "    cd crates && cargo build --release -p oxagen-cli\n"
        "or set STELLA_BINARY=/abs/path/to/stella\n"
        f"(looked for {candidate})"
    )


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _task_budget_flags() -> list[str]:
    """Per-task USD spend cap (stella's ``--budget`` flag)."""
    raw = os.environ.get("STELLA_BUDGET")
    if raw and raw.strip():
        try:
            usd = float(raw.strip())
            if usd > 0:
                return [f"--budget {usd:g}"]
        except ValueError:
            print(
                f"stella-adapter: STELLA_BUDGET={raw!r} is not a number; running with no cap",
                file=sys.stderr,
            )
    return []


class StellaAgent(BaseInstalledAgent):
    """Run the Stella (Rust) coding CLI as a Harbor installed agent."""

    @staticmethod
    def name() -> str:
        return "stella"

    def get_version_command(self) -> str | None:
        return "stella --version"

    def parse_version(self, stdout: str) -> str:
        # stella prints "stella 0.1.0"
        return stdout.strip()

    async def install(self, environment) -> None:
        binary_path = _locate_binary()

        # Upload the static binary and install it.
        await environment.upload_file(binary_path, _BINARY_REMOTE_TMP)
        await self.exec_as_root(
            environment,
            command=(
                f"cp {_BINARY_REMOTE_TMP} {_BINARY_INSTALL_PATH} && "
                f"chmod +x {_BINARY_INSTALL_PATH} && "
                f"stella --version"
            ),
        )

        # Install ripgrep for fast search (best-effort, same as oxagen_agent.py).
        rg_binary = self._cached_rg_binary()
        if rg_binary:
            await self._provision_search_tool(environment, "rg", rg_binary)

    async def _provision_search_tool(self, environment, name: str, binary: Path | None) -> None:
        """Upload a static search-tool binary to ``/usr/local/bin/<name>`` (best-effort)."""
        if binary is None:
            return
        try:
            probe = await environment.exec(command=f"command -v {name}", timeout_sec=30)
            if probe.return_code == 0:
                self.logger.info("stella-adapter: %s already present, skipping upload", name)
                return
        except Exception:
            pass

        remote_tmp = f"/tmp/stella-{name}"
        await environment.upload_file(binary, remote_tmp)
        await self.exec_as_root(
            environment,
            command=(
                f"command -v {name} >/dev/null 2>&1 || "
                f"{{ cp {remote_tmp} /usr/local/bin/{name} && chmod +x /usr/local/bin/{name}; }}"
            ),
        )

    def _cached_rg_binary(self) -> Path | None:
        """Download (once), verify, and extract the static ``rg`` binary."""
        cache = Path.home() / ".cache" / "stella-bench"
        cache.mkdir(parents=True, exist_ok=True)

        rg_version = "14.1.0"
        rg_binary = cache / f"rg-{rg_version}-x86_64-musl"
        if rg_binary.is_file():
            return rg_binary

        # Lazy import for urllib only if needed.
        import hashlib
        import tarfile
        import tempfile
        import urllib.request

        url = f"https://github.com/BurntSushi/ripgrep/releases/download/{rg_version}/ripgrep-{rg_version}-x86_64-unknown-linux-musl.tar.gz"
        tarball = cache / f"ripgrep-{rg_version}-x86_64-musl.tar.gz"
        sha256 = "f84757b07f425fe5cf11d87df6644691c644a5cd2348a2c670894272999d3ba7"

        try:
            if not tarball.is_file():
                urllib.request.urlretrieve(url, tarball)  # noqa: S310
            digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
            if digest != sha256:
                print(f"stella-adapter: ripgrep tarball sha256 mismatch; skipping", file=sys.stderr)
                tarball.unlink(missing_ok=True)
                return None
            with tarfile.open(tarball) as tf, tempfile.TemporaryDirectory() as td:
                member = f"ripgrep-{rg_version}-x86_64-unknown-linux-musl/rg"
                tf.extract(member, td, filter="data")
                (Path(td) / member).rename(rg_binary)
            rg_binary.chmod(0o755)
            return rg_binary
        except Exception as exc:
            print(f"stella-adapter: ripgrep provisioning failed ({exc}); skipping", file=sys.stderr)
            return None

    def _forwarded_env(self) -> dict[str, str]:
        """Host env to forward into the container for the agent run."""
        env: dict[str, str] = {}

        # Forward any STELLA_* tuning (model, api key, budget, etc.).
        for k, v in os.environ.items():
            if k.startswith("STELLA_"):
                env[k] = v

        # Force stream-json output for headless runs.
        env.setdefault("STELLA_OUTPUT_FORMAT", "stream-json")

        return env

    def _build_flags(self) -> str:
        """Flags for the stella invocation: ``stella run <flags> "<task>"``."""
        flags = ["--output-format", "stream-json"]
        flags.extend(_task_budget_flags())

        # Model pinning: harbor's -m is passed as self.model_name.
        if self.model_name:
            flags.extend(["--model", shlex.quote(self.model_name)])

        return " ".join(flags)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment,
        context: AgentContext,
    ) -> None:
        log_path = f"{EnvironmentPaths.agent_dir}/stella.txt"
        flags = self._build_flags()
        command = (
            f"mkdir -p {EnvironmentPaths.agent_dir}; "
            f"stella run {flags} {shlex.quote(instruction)} "
            f"2>&1 | stdbuf -oL tee {log_path}"
        )
        await self.exec_as_agent(
            environment,
            command=command,
            env=self._forwarded_env(),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse the stream-json output for Harbor telemetry.

        Stella emits ``AgentEvent`` as JSONL (see crates/oxagen-protocol/src/event.rs).
        The final ``Complete`` event carries ``model`` and ``cost_usd``.
        """
        log = self._find_agent_log()
        if log is None:
            return

        text = log.read_text(errors="replace")
        self._parse_stream_json_events(context, text)

    def _parse_stream_json_events(self, context: AgentContext, text: str) -> None:
        """Parse AgentEvent JSONL and extract metadata."""
        total_cost = 0.0
        model = None
        steps = 0
        files_changed = set()
        events = []

        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue

            events.append(event)
            event_type = event.get("type")

            if event_type == "complete":
                model = event.get("model")
                total_cost = event.get("cost_usd", total_cost)
            elif event_type == "stage":
                # Count execute stages as a proxy for steps.
                if event.get("name") == "execute":
                    steps += 1
            elif event_type == "file_change":
                files_changed.add(event.get("path", ""))

        if model:
            context.metadata = {
                **(context.metadata or {}),
                "stella_model": model,
                "stella_files_touched": len(files_changed),
                "stella_steps": steps,
            }
            context.cost_usd = total_cost

    def _find_agent_log(self) -> Path | None:
        candidate = Path(self.logs_dir) / "agent" / "stella.txt"
        if candidate.is_file():
            return candidate
        matches = sorted(Path(self.logs_dir).rglob("stella.txt"))
        return matches[-1] if matches else None
