"""Harbor agent adapter for the Oxagen coding CLI.

Implements Harbor's ``BaseInstalledAgent`` so the ``oxagen`` agent can be
benchmarked on Terminal-Bench (and any Harbor dataset) head-to-head with
Claude Code, Codex CLI, etc.

How it works
------------
Oxagen is a Node CLI that lives in a monorepo and whose published npm package is
not standalone-installable. Instead of installing from npm, this adapter uploads
a **self-contained single-file bundle** (built by ``pnpm --filter @oxagen/cli
bundle`` → ``apps/cli/dist-standalone/oxagen.mjs``) into the task container,
installs Node 22, drops a ``/usr/local/bin/oxagen`` wrapper, and runs the agent
headlessly in the task working directory with ``--mode bypass`` (fully
autonomous: file edits + shell, no human in the loop).

Model selection
---------------
Harbor passes ``-m <provider>/<model>`` which is exactly an Oxagen AI-Gateway
slug, so it is forwarded verbatim to ``oxagen --model``. To benchmark Oxagen's
own cost-aware router instead of a pinned model, set ``OXAGEN_ROUTE=1`` (or omit
``-m``) and the adapter drops ``--model`` so Oxagen routes per task.

Environment
-----------
- ``AI_GATEWAY_API_KEY`` (required) — forwarded into the container; all Oxagen
  LLM calls go through the Vercel AI Gateway.
- ``OXAGEN_CLI_BUNDLE`` — path to ``oxagen.mjs`` (defaults to the repo build).
- ``OXAGEN_ROUTE=1`` — let Oxagen's router pick the model (ignore ``-m``).
- ``OXAGEN_NO_PIPELINE=1`` — skip prompt-eval / context-injection / completeness
  judging (leaner + cheaper; the default keeps the full Oxagen scaffold on).
- ``OXAGEN_INSTALL_DUCKDB=1`` — also ``npm i`` DuckDB in the container so the
  context engine's persistent memory/trace stores are live. Off by default:
  DuckDB is not load-bearing for a cold single-trial run (no pre-pulled graph,
  no prior sessions) and the CLI degrades gracefully without it.  Set
  automatically by ``run.sh`` when ``OXAGEN_WARM=1``.
- ``OXAGEN_WARM_MEMORY_DIR`` — host-side directory for cross-trial memory
  persistence (warm / self-improvement mode).  When set the adapter:
    1. uploads the directory's contents into the container during ``install()``
       so the agent starts each trial with the accumulated memory from all
       prior trials;
    2. downloads the updated ``~/.config/oxagen`` back to this directory at the
       end of ``run()`` so the next trial inherits it.
  Set ``OXAGEN_WARM=1`` in ``run.sh`` to activate warm mode; that sets both
  ``OXAGEN_INSTALL_DUCKDB=1`` and a default ``OXAGEN_WARM_MEMORY_DIR``.
  See "Warm / self-improvement mode" in the README for full documentation.
- Any other ``OXAGEN_*`` var on the host is forwarded (e.g. ``OXAGEN_MODEL``,
  tier overrides ``OXAGEN_LLM_FAST`` / ``_BALANCED`` / ``_PRECISE``).

Warm mode — honest limitation
------------------------------
Harbor deletes the trial container after each run (``environment.delete: true``
in Terminal-Bench's default config).  Cross-trial persistence is achieved by
downloading ``~/.config/oxagen`` from the container to the host after every run
and uploading it into the next container's ``install()`` — so memory truly
persists between trials, not just within a trial.

This works correctly as long as:
  - ``OXAGEN_WARM_MEMORY_DIR`` is on the same machine running Harbor (localhost
    or the Harbor worker host).  Remote/cloud Harbor workers need the warm dir
    to be on shared storage accessible from the worker.
  - Trials are serialized (``--n-concurrent 1``).  Parallel trials write to the
    same warm dir simultaneously, causing races; use ``N_CONCURRENT=1`` for warm
    runs.

With ``N_CONCURRENT=1`` on a single machine the upload/download loop is fully
real and deterministic.  No fake persistence — if the download or upload fails,
the adapter logs it to stderr and the next trial starts cold (rather than
silently with stale state).
"""

from __future__ import annotations

import os
import re
import shlex
import sys
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# In-container locations.
_BUNDLE_REMOTE_TMP = "/tmp/oxagen.mjs"
_BUNDLE_INSTALL_DIR = "/usr/local/lib/oxagen"
_BUNDLE_INSTALL_PATH = f"{_BUNDLE_INSTALL_DIR}/oxagen.mjs"
_WRAPPER_PATH = "/usr/local/bin/oxagen"

# In-container HOME used in warm mode.  All of Oxagen's path helpers call
# node:os.homedir() which reads HOME, so pinning HOME to this path makes
# ~/.config/oxagen/ resolve to _WARM_HOME_IN_CONTAINER/.config/oxagen/ —
# the same path we upload into and download from across trials.
_WARM_HOME_IN_CONTAINER = "/tmp/oxa-warm-home"
_WARM_CONFIG_IN_CONTAINER = f"{_WARM_HOME_IN_CONTAINER}/.config/oxagen"

# Minimum Node major the bundle needs; skip reinstall if the image already has it.
_MIN_NODE_MAJOR = 20
_NODE_SETUP_MAJOR = 22


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _locate_bundle() -> Path:
    """Resolve the path to the standalone ``oxagen.mjs`` bundle on the host."""
    override = os.environ.get("OXAGEN_CLI_BUNDLE")
    if override:
        p = Path(override).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"OXAGEN_CLI_BUNDLE points at a missing file: {p}")
        return p

    # Editable install (`uv pip install -e .`) keeps __file__ inside the repo:
    # .../bench/terminal-bench/src/oxagen_terminal_bench/oxagen_agent.py
    # repo root is parents[4].
    repo_root = Path(__file__).resolve().parents[4]
    candidate = repo_root / "apps" / "cli" / "dist-standalone" / "oxagen.mjs"
    if candidate.is_file():
        return candidate

    raise FileNotFoundError(
        "Could not find the oxagen standalone bundle.\n"
        "Build it first:\n"
        "    pnpm --filter @oxagen/cli bundle\n"
        "or set OXAGEN_CLI_BUNDLE=/abs/path/to/oxagen.mjs\n"
        f"(looked for {candidate})"
    )


# Shell snippet: install Node {major} system-wide if a recent enough Node is
# absent. Covers Debian/Ubuntu (NodeSource), Alpine (apk), RHEL (NodeSource).
_NODE_INSTALL_SCRIPT = f"""
set -eu
have_node=0
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${{major:-0}}" -ge {_MIN_NODE_MAJOR} ]; then have_node=1; fi
fi
if [ "$have_node" -eq 0 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_{_NODE_SETUP_MAJOR}.x | bash -
    apt-get install -y nodejs
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_{_NODE_SETUP_MAJOR}.x | bash -
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_{_NODE_SETUP_MAJOR}.x | bash -
    yum install -y nodejs
  else
    echo "oxagen-adapter: no supported package manager to install Node" >&2
    exit 1
  fi
fi
node --version
"""


class OxagenAgent(BaseInstalledAgent):
    """Run the Oxagen coding CLI as a Harbor installed agent."""

    @staticmethod
    def name() -> str:
        return "oxagen"

    def get_version_command(self) -> str | None:
        return "oxagen --version"

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[0].strip() if stdout.strip() else stdout

    async def install(self, environment: BaseEnvironment) -> None:
        bundle_path = _locate_bundle()

        # 1) Node runtime (system-wide so the wrapper resolves `node` for any user).
        await self.exec_as_root(
            environment,
            command=_NODE_INSTALL_SCRIPT,
            timeout_sec=600,
        )

        # 2) Upload the self-contained bundle and install a tiny launcher.
        await environment.upload_file(bundle_path, _BUNDLE_REMOTE_TMP)
        wrapper = "#!/bin/sh\\nexec node " + _BUNDLE_INSTALL_PATH + ' "$@"\\n'
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {_BUNDLE_INSTALL_DIR} && "
                f"cp {_BUNDLE_REMOTE_TMP} {_BUNDLE_INSTALL_PATH} && "
                f"printf '{wrapper}' > {_WRAPPER_PATH} && "
                f"chmod +x {_WRAPPER_PATH} && "
                f"oxagen --version"
            ),
        )

        # 3) Optional: live context engine (persistent memory/trace via DuckDB).
        if _is_truthy(os.environ.get("OXAGEN_INSTALL_DUCKDB")):
            await self.exec_as_root(
                environment,
                command=(
                    f"npm install --prefix {_BUNDLE_INSTALL_DIR} duckdb || "
                    'echo "oxagen-adapter: optional duckdb install failed; '
                    'continuing without persistent context engine" >&2'
                ),
                timeout_sec=600,
            )

        # 4) Warm mode: upload prior-trial memory into the container so this
        #    trial starts with accumulated state from all preceding trials.
        #
        #    The in-container HOME is pinned to _WARM_HOME_IN_CONTAINER in
        #    _forwarded_env() so that Oxagen writes all its stores under
        #    _WARM_CONFIG_IN_CONTAINER during this trial.  Here we seed that
        #    directory with whatever the host-side warm dir contains.
        warm_dir = os.environ.get("OXAGEN_WARM_MEMORY_DIR")
        if warm_dir:
            host_config = Path(warm_dir) / ".config" / "oxagen"
            # Create the in-container home path so Oxagen can always write there.
            await self.exec_as_root(
                environment,
                command=f"mkdir -p {_WARM_CONFIG_IN_CONTAINER}",
            )
            if host_config.is_dir() and any(host_config.iterdir()):
                try:
                    await environment.upload_dir(host_config, _WARM_CONFIG_IN_CONTAINER)
                    self.logger.info(
                        "oxagen-adapter: uploaded warm memory from %s into %s",
                        host_config,
                        _WARM_CONFIG_IN_CONTAINER,
                    )
                except Exception as exc:
                    print(
                        f"oxagen-adapter: warm memory upload failed ({exc}); "
                        "this trial starts cold",
                        file=sys.stderr,
                    )

    def _forwarded_env(self) -> dict[str, str]:
        """Host env to forward into the container for the agent run."""
        env: dict[str, str] = {}
        key = os.environ.get("AI_GATEWAY_API_KEY")
        if not key:
            raise ValueError(
                "AI_GATEWAY_API_KEY must be set on the host — Oxagen routes all "
                "LLM calls through the Vercel AI Gateway."
            )
        env["AI_GATEWAY_API_KEY"] = key
        # Forward any OXAGEN_* tuning (model, tier slugs, etc.).
        for k, v in os.environ.items():
            if k.startswith("OXAGEN_") and k != "OXAGEN_CLI_BUNDLE":
                env[k] = v
        # Session bypass + memory isolation defaults (host env wins via the
        # forwarding loop above): trials never log in, so requireSession()
        # must return the synthetic bench session; and unless warm memory is
        # explicitly enabled, recall is disabled — SWE-bench reuses the same
        # repos across instances, so recalled context would cross-contaminate
        # trials.
        env.setdefault("OXAGEN_ALLOW_NO_SESSION", "1")
        if not os.environ.get("OXAGEN_WARM_MEMORY_DIR"):
            env.setdefault("OXAGEN_DISABLE_MEMORY", "1")
        # Warm mode: pin HOME to a stable in-container path so all of Oxagen's
        # node:os.homedir() calls resolve to _WARM_HOME_IN_CONTAINER rather than
        # whatever the trial container's default user home happens to be.  This
        # makes _WARM_CONFIG_IN_CONTAINER the canonical config dir for the trial
        # and ensures the post-run download (in run()) targets the right path.
        if os.environ.get("OXAGEN_WARM_MEMORY_DIR"):
            env["HOME"] = _WARM_HOME_IN_CONTAINER
        return env

    def _build_flags(self) -> str:
        flags = ["--mode bypass", "--verbose"]
        route = _is_truthy(os.environ.get("OXAGEN_ROUTE"))
        if self.model_name and not route:
            flags.append(f"--model {shlex.quote(self.model_name)}")
        if _is_truthy(os.environ.get("OXAGEN_NO_PIPELINE")):
            flags.append("--no-pipeline")
        return " ".join(flags)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        log_path = f"{EnvironmentPaths.agent_dir}/oxagen.txt"
        command = (
            f"mkdir -p {EnvironmentPaths.agent_dir}; "
            f"oxagen {self._build_flags()} {shlex.quote(instruction)} "
            f"2>&1 | stdbuf -oL tee {log_path}"
        )
        # Runs in the container's default working directory — the task repo.
        await self.exec_as_agent(
            environment,
            command=command,
            env=self._forwarded_env(),
        )

        # Warm mode: download updated memory back to the host after the run so
        # the next trial inherits it.  This is the cross-trial persistence
        # mechanism — Harbor deletes the container after each trial
        # (environment.delete: true), so we must snapshot state here.
        #
        # Failure is non-fatal: if the download fails, a warning is printed and
        # the next trial starts cold rather than with stale/partial state.
        warm_dir = os.environ.get("OXAGEN_WARM_MEMORY_DIR")
        if warm_dir:
            host_config = Path(warm_dir) / ".config" / "oxagen"
            host_config.mkdir(parents=True, exist_ok=True)
            try:
                await environment.download_dir(_WARM_CONFIG_IN_CONTAINER, host_config)
                self.logger.info(
                    "oxagen-adapter: downloaded warm memory from %s to %s",
                    _WARM_CONFIG_IN_CONTAINER,
                    host_config,
                )
            except Exception as exc:
                print(
                    f"oxagen-adapter: warm memory download failed ({exc}); "
                    "next trial will start without this trial's memory",
                    file=sys.stderr,
                )

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Oxagen's persistent cost store (DuckDB) is absent in the cold task
        # container, but `--verbose` prints a final efficiency roll-up, e.g.:
        #     efficiency
        #         815.53s total · 83086 tok · $0.2714
        #         102 tok/s · 37 steps · 5 file(s) changed · $0.0543/file
        # Parse it so Oxagen's cost shows up in Harbor results (Oxagen reports a
        # single undifferentiated token total, so set cost_usd + metadata rather
        # than faking an input/output split).
        log = self._find_agent_log()
        if log is None:
            return
        text = log.read_text(errors="replace")
        m = re.search(r"([\d.]+)s total\D+([\d,]+)\s*tok\D+\$([\d.]+)", text)
        if not m:
            return
        wall_sec = float(m.group(1))
        total_tokens = int(m.group(2).replace(",", ""))
        context.cost_usd = float(m.group(3))
        steps_m = re.search(r"(\d+)\s*steps", text)
        context.metadata = {
            **(context.metadata or {}),
            "oxagen_total_tokens": total_tokens,
            "oxagen_wall_sec": wall_sec,
            "oxagen_steps": int(steps_m.group(1)) if steps_m else None,
        }

    def _find_agent_log(self) -> Path | None:
        candidate = Path(self.logs_dir) / "agent" / "oxagen.txt"
        if candidate.is_file():
            return candidate
        matches = sorted(Path(self.logs_dir).rglob("oxagen.txt"))
        return matches[-1] if matches else None
