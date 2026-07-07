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
  judging in the ONE-SHOT ``--mode bypass`` path only (leaner + cheaper; the
  default keeps the full Oxagen scaffold on). Has no effect under
  ``OXAGEN_BEST_OF_N=1`` — that mode has its own dedicated gate, below.
- ``OXAGEN_BEST_OF_N=1`` — run Oxagen's best-of-N differentiator instead of a
  single one-shot turn: ``oxagen solve --candidates <N> [--model X]
  [--pipeline] "<task>"`` runs N independent candidates (each its own isolated
  worktree + engine loop), a comparative judge picks the winner, and the
  winner's diff is applied to the container's working directory — so the
  container's resulting ``git diff`` is still exactly what Harbor's verifier
  grades. ``--mode bypass`` has no ``solve`` equivalent and none is needed:
  candidates run headlessly with no confirmation gate to bypass.
- ``OXAGEN_BEST_OF_N_CANDIDATES`` — how many candidates per task under
  ``OXAGEN_BEST_OF_N=1`` (default 3; mirrors ``solve --candidates``).
  ``run.sh``'s ``OXAGEN_DIFFERENTIATED=1`` recipe defaults this to 5.
- ``OXAGEN_BEST_OF_N_MODELS`` — comma-separated gateway slugs forwarded
  verbatim to ``solve --models`` (candidate model mix, cycled for diversity).
  Takes precedence over ``-m``/``--model`` when set, mirroring solve.ts's own
  ``--models`` > ``--model`` precedence. Unset ⇒ falls back to pinning a
  single model (or omitting it under ``OXAGEN_ROUTE=1``), exactly as before
  this existed. ``run.sh``'s ``OXAGEN_DIFFERENTIATED=1`` recipe defaults this
  to a cross-family mix (3x ``anthropic/claude-fable-5`` + 2x
  ``openai/gpt-5.5-pro``) — a wider, cross-vendor candidate pool finds a
  correct fix more often than a narrower same-family one.
- ``OXAGEN_BEST_OF_N_PIPELINE=1`` — under ``OXAGEN_BEST_OF_N=1``, run every
  candidate through the full evaluate→enhance→route→execute→judge→revise
  pipeline (``--pipeline``) instead of the bare engine loop: each candidate
  gets its OWN completeness judge/revise round AND the semantic-enhance
  pre-context (embed the prompt, pull related files from the persisted code
  graph) BEFORE the comparative selector ever compares them. This is a
  deliberate double-judge — each candidate self-improves first, then the
  N (already-improved) candidates are compared — not accidental redundancy.
  Off by default (bare: one comparison judge only, no per-candidate judge/
  enhance). Costs roughly N extra judge-class calls plus N evaluate/enhance
  calls on top of what bare already costs. ``run.sh``'s
  ``OXAGEN_DIFFERENTIATED=1`` recipe turns this on by default.
- ``OXAGEN_BEST_OF_N_VERIFY=1`` — under ``OXAGEN_BEST_OF_N=1``, append
  ``--verify-auto``: union the test/lint/build commands every candidate
  actually ran during its own turn and re-run that whole union in EVERY
  surviving candidate's worktree before selection, so the comparative
  selector's "tests pass" signal is real, executed evidence across the whole
  pool instead of whatever subset of tests each candidate happened to run on
  its own. Off by default. ``run.sh``'s ``OXAGEN_DIFFERENTIATED=1`` recipe
  turns this on by default.
- ``OXAGEN_INSTALL_DUCKDB=1`` — also ``npm i`` DuckDB in the container so the
  context engine's persistent memory/trace stores are live, AND so the code
  graph ``oxagen init`` pre-builds in ``install()`` (see ``_INIT_SCRIPT``
  below) actually persists to disk for ``run()`` to reuse. Off by default: for
  a cold single-trial run with no warm memory, the CLI degrades gracefully
  without it (in-memory fallback, no crash — ``init.ts``'s
  ``createCodeGraphStore()`` call is inside its try/catch precisely so a
  missing duckdb binding never crashes ``oxagen init``). But that in-memory
  fallback IS thrown away the moment the ``install()`` process exits, so
  without this flag the ``oxagen init`` pre-build is pure overhead — it builds
  a graph nothing downstream ever reads. Set automatically by ``run.sh`` when
  ``OXAGEN_WARM=1`` or ``OXAGEN_DIFFERENTIATED=1``.
- ``OXAGEN_DIFFERENTIATED=1`` — a ``run.sh``-level convenience flag (not read
  by this adapter directly) that turns on the full differentiated config in
  one shot: persisted code graph + embeddings (``OXAGEN_INSTALL_DUCKDB=1``), a
  fast gateway-tier coordinator for the pipeline's evaluate/route stage
  (``OXAGEN_LLM_FAST``), best-of-5 cross-family (``OXAGEN_BEST_OF_N_MODELS``),
  auto-verify (``OXAGEN_BEST_OF_N_VERIFY=1``), a real evaluator/advisor
  (``OXAGEN_LLM_EVALUATOR``/``OXAGEN_LLM_ADVISOR``), max reasoning effort
  (``OXAGEN_EFFORT=xhigh``), and two judge→revise rounds per candidate
  (``OXAGEN_MAX_REVISE_ROUNDS=2``). See "Best-of-N mode" and
  "Full differentiated config" in the README — including why the on-device
  local coordinator is NOT part of this recipe (local-dev-only, not
  container-viable).
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

import hashlib
import json
import os
import re
import shlex
import sys
import tarfile
import tempfile
import urllib.request
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
# Marker written by the prewarm overlay image (bench/swe-bench/prewarm/
# Dockerfile) next to the baked-in bundle: the bundle's sha256 hex digest.
# install() compares it against the local bundle and skips the bundle/wasm
# upload + wrapper write on a match.
_BUNDLE_SHA_MARKER_PATH = f"{_BUNDLE_INSTALL_DIR}/.bundle.sha256"

# In-container HOME used in warm mode.  All of Oxagen's path helpers call
# node:os.homedir() which reads HOME, so pinning HOME to this path makes
# ~/.config/oxagen/ resolve to _WARM_HOME_IN_CONTAINER/.config/oxagen/ —
# the same path we upload into and download from across trials.
_WARM_HOME_IN_CONTAINER = "/tmp/oxa-warm-home"
_WARM_CONFIG_IN_CONTAINER = f"{_WARM_HOME_IN_CONTAINER}/.config/oxagen"

# Minimum Node major the bundle needs; skip reinstall if the image already has it.
_MIN_NODE_MAJOR = 20
_NODE_SETUP_MAJOR = 22

# Default candidate count for `oxagen solve` under OXAGEN_BEST_OF_N=1, mirroring
# the CLI's own default (`solve --candidates` defaults to 3, see solve.ts).
_DEFAULT_BEST_OF_N_CANDIDATES = 3

# Static ripgrep for the task container (x86_64 musl — SWE-bench images are
# x86_64, and a musl static binary runs on any distro). Without rg on PATH the
# CLI's `grep` tool falls back to an in-process JS walk that reads every file
# in the repo — pathologically slow on Django-sized trees under emulation.
# Pinned version + sha256 (computed from the official GitHub release asset);
# extracted once to a host cache and uploaded per container.
_RG_VERSION = "14.1.0"
_RG_URL = (
    "https://github.com/BurntSushi/ripgrep/releases/download/"
    f"{_RG_VERSION}/ripgrep-{_RG_VERSION}-x86_64-unknown-linux-musl.tar.gz"
)
_RG_SHA256 = "f84757b07f425fe5cf11d87df6644691c644a5cd2348a2c670894272999d3ba7"


def _cached_rg_binary() -> Path | None:
    """Download (once), verify, and extract the static `rg` binary on the host.

    Returns the path to the extracted binary, or None on any failure — rg is an
    optimization, never a trial blocker.
    """
    cache = Path.home() / ".cache" / "oxagen-bench"
    cache.mkdir(parents=True, exist_ok=True)
    binary = cache / f"rg-{_RG_VERSION}-x86_64-musl"
    if binary.is_file():
        return binary
    tarball = cache / f"ripgrep-{_RG_VERSION}-x86_64-musl.tar.gz"
    try:
        if not tarball.is_file():
            urllib.request.urlretrieve(_RG_URL, tarball)  # noqa: S310 — pinned https URL
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        if digest != _RG_SHA256:
            print(
                f"oxagen-adapter: ripgrep tarball sha256 mismatch ({digest}); skipping",
                file=sys.stderr,
            )
            tarball.unlink(missing_ok=True)
            return None
        member = f"ripgrep-{_RG_VERSION}-x86_64-unknown-linux-musl/rg"
        with tarfile.open(tarball) as tf, tempfile.TemporaryDirectory() as td:
            tf.extract(member, td, filter="data")
            (Path(td) / member).rename(binary)
        binary.chmod(0o755)
        return binary
    except Exception as exc:
        print(f"oxagen-adapter: ripgrep provisioning failed ({exc}); skipping", file=sys.stderr)
        return None


def _is_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _best_of_n_enabled() -> bool:
    return _is_truthy(os.environ.get("OXAGEN_BEST_OF_N"))


def _best_of_n_pipeline_enabled() -> bool:
    """Whether `solve` candidates run the full evaluate/enhance/judge/revise
    pipeline (--pipeline) instead of the bare engine loop. Dedicated gate —
    NOT the same var as OXAGEN_NO_PIPELINE (that one only controls the
    one-shot `--mode bypass` path's scaffold) — because the two modes have
    genuinely different default costs: the one-shot pipeline is the
    established default, while `solve`'s pipeline-per-candidate is an
    explicit, expensive-by-design opt-in (each candidate self-judges/revises
    BEFORE the comparative selector ever sees it — the double-judge is
    intentional, not accidental redundancy). Read directly here rather than
    only relying on the CLI's own OXAGEN_BEST_OF_N_PIPELINE fallback (see
    solve.ts) so the constructed command is self-documenting in the trial
    logs instead of depending on a silent env-var default inside the CLI.
    """
    return _is_truthy(os.environ.get("OXAGEN_BEST_OF_N_PIPELINE"))


def _best_of_n_models() -> str | None:
    """Comma-separated cross-family model mix for `solve --models`, read
    straight from OXAGEN_BEST_OF_N_MODELS (solve.ts splits/trims it exactly
    like `--models` does — no re-parsing needed here). None when unset —
    `_build_best_of_n_flags()` then falls back to pinning `-m`/`--model` to a
    single model (or omitting it under OXAGEN_ROUTE=1), exactly as before this
    existed. `run.sh`'s OXAGEN_DIFFERENTIATED=1 recipe sets a default
    5-candidate cross-vendor mix (3x anthropic/claude-fable-5 + 2x
    openai/gpt-5.5-pro) — see "Full differentiated config" in the README.
    """
    raw = os.environ.get("OXAGEN_BEST_OF_N_MODELS")
    return raw.strip() if raw and raw.strip() else None


def _verify_auto_enabled() -> bool:
    """Whether `solve` candidates auto-verify: union the test/lint/build
    commands every candidate actually ran and re-run that union in every
    OTHER candidate's worktree too before selection, feeding the comparative
    selector a real, executed-test signal across the whole pool instead of
    whatever subset of tests each candidate happened to run on its own. Read
    directly here (like `_best_of_n_pipeline_enabled()`) so the constructed
    command is self-documenting in the trial logs rather than depending on a
    silent env-var default inside the CLI. `run.sh`'s OXAGEN_DIFFERENTIATED=1
    recipe turns this on by default.
    """
    return _is_truthy(os.environ.get("OXAGEN_BEST_OF_N_VERIFY"))


def _best_of_n_candidate_count() -> int:
    """Parse OXAGEN_BEST_OF_N_CANDIDATES; falls back to the default on anything
    non-numeric rather than letting a typo'd env var crash the whole run."""
    raw = os.environ.get("OXAGEN_BEST_OF_N_CANDIDATES")
    if not raw:
        return _DEFAULT_BEST_OF_N_CANDIDATES
    try:
        n = int(raw.strip())
    except ValueError:
        print(
            f"oxagen-adapter: OXAGEN_BEST_OF_N_CANDIDATES={raw!r} is not an int; "
            f"using default {_DEFAULT_BEST_OF_N_CANDIDATES}",
            file=sys.stderr,
        )
        return _DEFAULT_BEST_OF_N_CANDIDATES
    return max(1, n)


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
#
# Fast path: if the image already ships Node >= _MIN_NODE_MAJOR (e.g. a
# pre-baked task image with Node 22) this entire script exits in < 1s
# after the version check — no package-manager round-trip at all.  That turns
# the ~109s "agent setup" overhead (measured in the smoke run) into < 5s.
#
# To pre-bake task images for SWE-bench, use the prewarm tooling in
# bench/swe-bench/ (see PREWARM.md there):
#   1. `prewarm.py` builds oxagen-prewarmed/<name>:<envhash>-<bundlesha>
#      images (Node 22 + bundle + wasm + rg + wrapper baked in) on top of
#      each task's own environment image;
#   2. run.sh with OXAGEN_PREWARMED=1 passes Harbor
#      `--env oxagen_swe_bench.prewarm_env:PrewarmedDockerEnvironment`,
#      which points the trial at that image when it exists locally;
#   3. this adapter's `.bundle.sha256` probe (see install()) then skips the
#      bundle/wasm re-upload as well.
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
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_{_NODE_SETUP_MAJOR}.x | bash -
    apt-get install -y -qq nodejs
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
else
  echo "oxagen-adapter: Node $(node --version) already present — skipping install"
fi
node --version
"""

# Shell snippet: run `oxagen init --no-link` in the task working directory to
# build the code graph (tree-sitter parse + symbol index) and infer domain names
# before the agent loop starts.  This front-loads the 135s+ cold graph-build
# that otherwise blocks the first `code_graph` tool call mid-execution, and
# makes the `code_graph` tool immediately useful from step 1.
#
# Domain inference (Haiku-class LLM call) annotates the graph nodes with domain
# names (e.g. "auth", "models", "views") so the agent's code_graph queries
# return richer, domain-aware results.
#
# Skipped when OXAGEN_SKIP_INIT=1 (e.g. for tasks where the repo is too large
# or init is known to be slow).  The agent degrades gracefully without it.
_INIT_SCRIPT = """
set -eu
echo "oxagen-adapter: running oxagen init to pre-build code graph and domain index..."
oxagen init --no-link --json 2>&1 | tail -5 || echo "oxagen-adapter: init failed (non-fatal)"
echo "oxagen-adapter: init complete"
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

    async def _bundle_prebaked(
        self, environment: BaseEnvironment, bundle_path: Path
    ) -> bool:
        """True when the container already carries this exact bundle pre-baked.

        A prewarmed image (bench/swe-bench/prewarm/Dockerfile) writes the
        baked bundle's sha256 to _BUNDLE_SHA_MARKER_PATH. Compare it against
        the local bundle; any mismatch, absence, or probe error means "not
        prebaked" — this must never block a trial.
        """
        try:
            local_sha = hashlib.sha256(bundle_path.read_bytes()).hexdigest()
            probe = await environment.exec(
                command=f"cat {_BUNDLE_SHA_MARKER_PATH} 2>/dev/null",
                timeout_sec=30,
            )
            return probe.return_code == 0 and probe.stdout.strip() == local_sha
        except Exception as exc:
            print(
                f"oxagen-adapter: prebaked-bundle probe failed ({exc}); "
                "uploading the bundle normally",
                file=sys.stderr,
            )
            return False

    async def install(self, environment: BaseEnvironment) -> None:
        bundle_path = _locate_bundle()

        # 1) Node runtime (system-wide so the wrapper resolves `node` for any user).
        await self.exec_as_root(
            environment,
            command=_NODE_INSTALL_SCRIPT,
            timeout_sec=600,
        )

        # 2) Upload the self-contained bundle AND its sibling tree-sitter WASM
        #    assets, then install a tiny launcher. The bundle loads web-tree-sitter
        #    (the code graph) which reads tree-sitter.wasm + the grammar wasms from
        #    its own directory (dist-standalone/) at runtime; esbuild can't inline
        #    binary wasm, so bundle.mjs copies them next to oxagen.mjs. If we upload
        #    only oxagen.mjs, Parser.init() hits ENOENT on tree-sitter.wasm and
        #    Emscripten ABORTS the whole process (exit 1) — so upload them too.
        #
        #    Fast path (best-effort): a pre-baked image (bench/swe-bench/
        #    prewarm/Dockerfile) carries the bundle + wasm + wrapper already
        #    and records the bundle's sha256 at _BUNDLE_SHA_MARKER_PATH. When
        #    that marker matches the local bundle, the whole upload block is
        #    skipped; any probe failure just falls through to the upload path.
        if await self._bundle_prebaked(environment, bundle_path):
            self.logger.info("oxagen-adapter: bundle: prebaked, skipping upload")
        else:
            await environment.upload_file(bundle_path, _BUNDLE_REMOTE_TMP)
            wasm_copies = ""
            for wasm in sorted(bundle_path.parent.glob("*.wasm")):
                remote_tmp = f"/tmp/{wasm.name}"
                await environment.upload_file(wasm, remote_tmp)
                wasm_copies += f"cp {remote_tmp} {_BUNDLE_INSTALL_DIR}/{wasm.name} && "
            wrapper = "#!/bin/sh\\nexec node " + _BUNDLE_INSTALL_PATH + ' "$@"\\n'
            await self.exec_as_root(
                environment,
                command=(
                    f"mkdir -p {_BUNDLE_INSTALL_DIR} && "
                    f"cp {_BUNDLE_REMOTE_TMP} {_BUNDLE_INSTALL_PATH} && "
                    f"{wasm_copies}"
                    f"printf '{wrapper}' > {_WRAPPER_PATH} && "
                    f"chmod +x {_WRAPPER_PATH} && "
                    f"oxagen --version"
                ),
            )

        # 3) Static ripgrep so the CLI's grep tool never falls back to the
        #    in-process JS walk (see _RG_* above). Best-effort: skipped when the
        #    image already has rg (probed first so pre-baked images pay zero
        #    upload cost) or provisioning failed.
        rg = _cached_rg_binary()
        if rg is not None:
            have_rg = False
            try:
                probe = await environment.exec(
                    command="command -v rg", timeout_sec=30
                )
                have_rg = probe.return_code == 0
            except Exception:
                have_rg = False  # probe is best-effort; fall back to upload
            if have_rg:
                self.logger.info(
                    "oxagen-adapter: rg already present in image, skipping upload"
                )
            else:
                await environment.upload_file(rg, "/tmp/oxa-rg")
                await self.exec_as_root(
                    environment,
                    command=(
                        "command -v rg >/dev/null 2>&1 || "
                        "{ cp /tmp/oxa-rg /usr/local/bin/rg && chmod +x /usr/local/bin/rg; }"
                    ),
                )

        # 4) Optional: live context engine (persistent memory/trace via DuckDB).
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

        # 5) Pre-build code graph + domain index via `oxagen init --no-link`.
        #    This front-loads the 135s+ cold tree-sitter build that would
        #    otherwise block the first `code_graph` tool call mid-execution.
        #    After init the graph is warm in the DuckDB store and domain names
        #    are indexed, so `code_graph` queries are useful from step 1.
        #    Skipped when OXAGEN_SKIP_INIT=1 or OXAGEN_NO_PIPELINE=1 (bare mode).
        if not _is_truthy(os.environ.get("OXAGEN_SKIP_INIT")) and not _is_truthy(
            os.environ.get("OXAGEN_NO_PIPELINE")
        ):
            # Pass env via the exec env= channel (same as the run() call
            # below), NOT inlined into the command string: Harbor logs every
            # command verbatim to trial.log, so an inline `env KEY=...` prefix
            # wrote the AI_GATEWAY_API_KEY secret into the log file.
            await self.exec_as_agent(
                environment,
                command=_INIT_SCRIPT,
                env=self._forwarded_env(),
                timeout_sec=300,  # tree-sitter parse of a large repo can take 2–3 min
            )

        # 6) Warm mode: upload prior-trial memory into the container so this
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
        # Export the gateway key under both names so it is available to:
        #   - Oxagen's own ensureGatewayKey() (reads AI_GATEWAY_API_KEY)
        #   - Any shell command the agent runs that calls the AI Gateway directly
        #   - The `oxagen init` pre-run that calls inferDomains (needs gateway key)
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
        # Grading runs the harness's own hidden, fixed tests — never whatever the
        # agent leaves on disk — so an agent that edits a test until it passes
        # "succeeds" locally and self-certifies, then scores 0 for real. Deny
        # test-file mutations structurally instead of just asking nicely.
        env.setdefault("OXAGEN_FORBID_TEST_EDITS", "1")
        # Warm mode: pin HOME to a stable in-container path so all of Oxagen's
        # node:os.homedir() calls resolve to _WARM_HOME_IN_CONTAINER rather than
        # whatever the trial container's default user home happens to be.  This
        # makes _WARM_CONFIG_IN_CONTAINER the canonical config dir for the trial
        # and ensures the post-run download (in run()) targets the right path.
        if os.environ.get("OXAGEN_WARM_MEMORY_DIR"):
            env["HOME"] = _WARM_HOME_IN_CONTAINER
        return env

    def _build_flags(self) -> str:
        """Flags for the default one-shot invocation: `oxagen <flags> "<task>"`."""
        flags = ["--mode bypass", "--verbose"]
        route = _is_truthy(os.environ.get("OXAGEN_ROUTE"))
        if self.model_name and not route:
            flags.append(f"--model {shlex.quote(self.model_name)}")
        if _is_truthy(os.environ.get("OXAGEN_NO_PIPELINE")):
            flags.append("--no-pipeline")
        return " ".join(flags)

    def _build_best_of_n_flags(self) -> str:
        """Flags for the best-of-N invocation: `oxagen solve <flags> "<task>"`.

        Mirrors `_build_flags()`'s model forwarding — a cross-family mix
        (`--models`, when OXAGEN_BEST_OF_N_MODELS is set; see
        `_best_of_n_models()`) takes precedence, else pin a single model
        (`-m`), else omit it under OXAGEN_ROUTE=1 so each candidate falls
        through to the engine's own default model — mirroring solve.ts's own
        `--models` > `--model` precedence, but targeting the `solve`
        subcommand. No `--mode` equivalent: every `solve` candidate already
        runs headlessly with no confirmation gate to bypass.

        `--pipeline` is appended under `OXAGEN_BEST_OF_N_PIPELINE=1` — see
        `_best_of_n_pipeline_enabled()`. Unlike `_build_flags()`'s
        `OXAGEN_NO_PIPELINE`, this is a dedicated, separately-gated toggle:
        every candidate runs the full evaluate→enhance→route→execute→
        judge→revise pipeline (semantic-enhance pre-context + a per-candidate
        completeness judge/revise round) BEFORE the comparative selector ever
        compares them — each candidate is self-improved, not just generated
        once. That is intentionally MORE expensive than a single per-candidate
        judge would suggest: roughly N extra judge-class model calls (one per
        candidate) plus N evaluate/enhance calls, stacked on top of the
        selector's own judging call. Off by default (bare — cheaper, one
        comparison judge only); `run.sh`'s `OXAGEN_DIFFERENTIATED=1` recipe
        turns it on.

        `--verify-auto` is appended under `OXAGEN_BEST_OF_N_VERIFY=1` — see
        `_verify_auto_enabled()`. Same self-documenting-trial-logs rationale
        as `--pipeline` above.

        `--json` is explicit even though `solve` already auto-detects headless
        via `!process.stdout.isTTY` (true here regardless: this command's
        stdout is always piped into `tee`, never a real tty) — belt-and-braces
        so the JSONL contract this adapter parses (see
        `_populate_best_of_n_metadata`) never silently depends on TTY detection.
        """
        flags = ["solve", f"--candidates {_best_of_n_candidate_count()}", "--json"]
        models = _best_of_n_models()
        route = _is_truthy(os.environ.get("OXAGEN_ROUTE"))
        if models:
            flags.append(f"--models {shlex.quote(models)}")
        elif self.model_name and not route:
            flags.append(f"--model {shlex.quote(self.model_name)}")
        if _best_of_n_pipeline_enabled():
            flags.append("--pipeline")
        if _verify_auto_enabled():
            flags.append("--verify-auto")
        return " ".join(flags)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        log_path = f"{EnvironmentPaths.agent_dir}/oxagen.txt"
        subcommand = self._build_best_of_n_flags() if _best_of_n_enabled() else self._build_flags()
        command = (
            f"mkdir -p {EnvironmentPaths.agent_dir}; "
            f"oxagen {subcommand} {shlex.quote(instruction)} "
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
        # than faking an input/output split). `solve` (OXAGEN_BEST_OF_N=1) has no
        # `--verbose` roll-up — it streams headless JSONL events instead — so
        # that mode is parsed separately below.
        log = self._find_agent_log()
        if log is None:
            return
        text = log.read_text(errors="replace")

        if _best_of_n_enabled():
            self._populate_best_of_n_metadata(context, text)
            return

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

    def _populate_best_of_n_metadata(self, context: AgentContext, text: str) -> None:
        """Pull the race outcome from `solve`'s headless JSONL stream — the
        final `type: "result"` line (see `resultEnvelope()` in
        `apps/cli/src/tui/best-of-n-view/index.tsx`).

        Deliberately does NOT set `context.cost_usd`: `best-of-n.ts` doesn't
        thread per-candidate token usage onto `Candidate` yet (a known CLI-side
        gap — the `--verbose` roll-up this adapter parses for the one-shot path
        has no best-of-N equivalent), and this adapter does not fabricate a
        number to fill the gap.
        """
        result: dict | None = None
        for line in reversed(text.splitlines()):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict) and obj.get("type") == "result":
                result = obj
                break
        if result is None:
            return
        candidates = result.get("candidates") or []
        winner_id = result.get("winnerId")
        winner = next((c for c in candidates if c.get("id") == winner_id), None)
        context.metadata = {
            **(context.metadata or {}),
            "oxagen_bestofn_candidates": len(candidates),
            "oxagen_bestofn_winner_id": winner_id,
            "oxagen_bestofn_winner_files": len(result.get("winnerFiles") or []),
            "oxagen_bestofn_winner_steps": winner.get("steps") if winner else None,
            "oxagen_bestofn_failed_candidates": sum(1 for c in candidates if c.get("failed")),
        }

    def _find_agent_log(self) -> Path | None:
        candidate = Path(self.logs_dir) / "agent" / "oxagen.txt"
        if candidate.is_file():
            return candidate
        matches = sorted(Path(self.logs_dir).rglob("oxagen.txt"))
        return matches[-1] if matches else None
