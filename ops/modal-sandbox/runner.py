# pyright: reportMissingImports=false, reportAttributeAccessIssue=false
"""
Oxagen sandbox runner — deployed to Modal as a single FastAPI app.

Pyright is silenced above because modal + fastapi are installed inside
the Modal image at deploy time, not in the repo's local toolchain.

Contract:
  POST /run
    headers: authorization: Bearer <MODAL_RUNNER_TOKEN>
    body:    { language, code, stdin?, env?, timeout_ms, memory_mb,
               network, org_id, workspace_id, image? }
    returns: { exit_code, stdout, stderr, duration_ms, timed_out, oom_killed }

  GET /healthz
    returns: { status: "ok" }

Deploy:
  cd ops/modal-sandbox
  .venv/bin/modal token set --token-id <id> --token-secret <secret> --profile oxagenai
  MODAL_PROFILE=oxagenai .venv/bin/modal secret create oxagen-runner MODAL_RUNNER_TOKEN=<token>
  MODAL_PROFILE=oxagenai .venv/bin/modal deploy runner.py

API notes for modal 1.4.3 (synchronicity-wrapped):
  - .aio wrappers: Sandbox.create, Sandbox.exec, Sandbox.wait, Sandbox.terminate,
    ContainerProcess.wait, StreamReader.read, StreamWriter.drain
  - StreamWriter.write + write_eof: synchronous, no .aio
  - Code staging: base64-encode + pipe to `sh -c 'base64 -d > /work/file'` via
    a separate exec call in the same sandbox. Avoids shell-quoting issues with
    arbitrary user code.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import modal
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Fast search toolchain — every image ships ripgrep (rg), fd, and fzf so agent
# shell commands never fall back to grep/find, which scan gitignored trees
# (node_modules etc.) and run 50-100× slower on real repos.  Debian names the
# fd binary `fdfind`, hence the /usr/local/bin/fd symlink; Alpine names it fd.
# ---------------------------------------------------------------------------

_FAST_SEARCH_APT: tuple[str, ...] = ("ripgrep", "fd-find", "fzf")
_FAST_SEARCH_APK = "apk add --no-cache ripgrep fd fzf"
_FD_SYMLINK = 'ln -sf "$(command -v fdfind)" /usr/local/bin/fd'

# ---------------------------------------------------------------------------
# Browser asset resolution.
#
# The durable "agent" image bakes browserd/browserctl in via add_local_file.
# Modal resolves those local paths LAZILY — at the first Sandbox.create that
# uses the image, not at deploy time. Durable images aren't attached to any
# function, so that first build is triggered from INSIDE the deployed runner
# container, where the repo's browser/ directory doesn't exist. Without this
# fallback every  POST /sandbox/create {image: "agent"}  dies with
# FileNotFoundError → an opaque 500 before any sandbox is created.
#
# Fix: the runner's own function image copies browser/ to /assets/browser
# (built at deploy time, when the files DO exist), and this resolver prefers
# the source tree (deploy machine, local dev) with /assets as the in-container
# fallback. Identical content hashes to the same image layer either way, so
# the cache stays consistent across build origins.
# ---------------------------------------------------------------------------

_BROWSER_SRC_DIR = Path(__file__).parent / "browser"
_BROWSER_BAKED_DIR = Path("/assets/browser")


def _browser_asset(name: str) -> str:
    for base in (_BROWSER_SRC_DIR, _BROWSER_BAKED_DIR):
        candidate = base / name
        if candidate.is_file():
            return str(candidate)
    # Neither location exists (e.g. importing on a machine without the repo);
    # return the source path so hydration raises a clear FileNotFoundError.
    return str(_BROWSER_SRC_DIR / name)

# ---------------------------------------------------------------------------
# Image catalog — keyed by language enum.
# The Node driver sends the language enum; we map it to a Modal Image.
# ---------------------------------------------------------------------------

LANG_IMAGES: dict[str, modal.Image] = {
    "node":   modal.Image.from_registry("node:20-alpine", add_python=None)
              .run_commands(_FAST_SEARCH_APK),
    "python": modal.Image.debian_slim(python_version="3.12")
              .apt_install(*_FAST_SEARCH_APT).run_commands(_FD_SYMLINK),
    "shell":  modal.Image.from_registry("alpine:3.20", add_python=None)
              .run_commands(_FAST_SEARCH_APK),
}

# (code filename inside /work, argv for exec)
LANG_ENTRY: dict[str, tuple[str, list[str]]] = {
    "node":   ("main.js",  ["node",    "/work/main.js"]),
    "python": ("main.py",  ["python",  "/work/main.py"]),
    "shell":  ("main.sh",  ["/bin/sh", "/work/main.sh"]),
}

# ---------------------------------------------------------------------------
# Durable sandbox images — used for long-lived reconnectable sandboxes.
# These include git (and curl for "agent") so repo-clone workflows work.
# NOTE: node uses debian-based node:20 (not alpine) so apt_install works.
#
# Browser automation lives exclusively in the "agent" image.
# The agent image pre-installs playwright + Chromium and bakes browserd /
# browserctl into /usr/local/bin.  A code agent drives the browser across
# exec() calls by piping JSON commands to browserctl via the exec stdin field:
#
#   POST /sandbox/exec  { "command": "python3 /usr/local/bin/browserctl",
#                         "stdin": "{\"op\":\"navigate\",\"url\":\"...\"}",
#                         ... }
#
# browserd stays alive between exec() calls (durable sandbox keeps processes
# running) so page state (cookies, form values, SPA routing) is preserved.
# ---------------------------------------------------------------------------

DURABLE_IMAGES: dict[str, modal.Image] = {
    "node":   modal.Image.from_registry("node:20")
              .apt_install("git", *_FAST_SEARCH_APT).run_commands(_FD_SYMLINK),
    "python": modal.Image.debian_slim(python_version="3.12")
              .apt_install("git", *_FAST_SEARCH_APT).run_commands(_FD_SYMLINK),
    "shell":  modal.Image.debian_slim(python_version="3.12")
              .apt_install("git", *_FAST_SEARCH_APT).run_commands(_FD_SYMLINK),
    # "agent" = Debian slim + Python 3.12 + git + curl + Playwright/Chromium.
    # add_local_file(local_path, remote_path, copy=True) bakes the file into the
    # image layer at build time (copy=True is required so the subsequent chmod
    # run_commands step can see the files).  Local paths are resolved relative to
    # the cwd where `modal deploy runner.py` is invoked (ops/modal-sandbox/).
    "agent": (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("git", "curl", *_FAST_SEARCH_APT)
        .pip_install("playwright==1.49.0")
        .run_commands(
            "playwright install-deps chromium",
            "playwright install chromium",
            "apt-get update && apt-get install -y fonts-liberation fonts-noto-color-emoji"
            " && rm -rf /var/lib/apt/lists/*",
        )
        # add_local_file signature (modal >= 0.66.40):
        #   add_local_file(local_path, remote_path, *, copy=False)
        # copy=True bakes the file into the image layer so the chmod step below works.
        # Paths via _browser_asset so hydration also works from inside the
        # deployed runner container (see the resolver's comment above).
        .add_local_file(_browser_asset("browserd.py"), "/usr/local/bin/browserd", copy=True)
        .add_local_file(_browser_asset("browserctl.py"), "/usr/local/bin/browserctl", copy=True)
        .run_commands(
            "chmod +x /usr/local/bin/browserd /usr/local/bin/browserctl",
            _FD_SYMLINK,
        )
    ),
}

# Working-directory persistence sentinel.
#
# Each /sandbox/exec runs a FRESH `sh -c` inside the durable container, so the
# shell's cwd resets to the image default every call — a `cd` in one command is
# invisible to the next.  The durable terminal (and any caller that wants a
# stateful shell) fixes this by threading the working directory: it passes the
# prior cwd in via OXAGEN_CWD and reads the resulting cwd back out.  The shell
# emits its final `pwd` on stdout behind this RS-delimited sentinel; the runner
# strips the trailer (`_split_cwd_trailer`) and returns it as the response's
# `cwd`.  ASCII RS (0x1e) never appears in normal terminal output, so the split
# is collision-proof; the token that follows it just aids log grepping.
_CWD_SENTINEL = "\x1e__OXAGEN_CWD__="

# Alias + cwd trampoline for /sandbox/exec.  POSIX shells parse the whole `-c`
# string before running any of it, so aliases defined inside the command
# string can never apply to that same string; defining them first and
# `eval`-ing the real command (passed via $OXAGEN_EXEC_CMD) makes the shell
# re-parse the command AFTER the aliases exist.  Works in dash, busybox ash,
# and bash (bash additionally needs expand_aliases in non-interactive mode).
# Scope is deliberately the top-level agent command only — nested scripts
# (make, repo test suites) spawn their own clean /bin/sh and keep real
# grep/find semantics.  The command -v guards keep custom template images
# without the tools behaving byte-identically to before.  Per-call opt-out:
# set OXAGEN_NO_FAST_ALIASES=1 in the exec env.
#
# After the aliases it restores the caller's OXAGEN_CWD (durable-terminal cwd
# persistence) and, after the command, prints the final `pwd` behind
# _CWD_SENTINEL.  The user command's exit code is captured BEFORE the trailer
# so `cd` reporting can never mask a real failure.  `printf '\036…'` writes the
# RS byte portably (busybox/dash/bash all honour octal escapes).
_FAST_ALIAS_TRAMPOLINE = (
    'if [ -z "$OXAGEN_NO_FAST_ALIASES" ]; then '
    '[ -n "$BASH_VERSION" ] && shopt -s expand_aliases 2>/dev/null; '
    "command -v rg >/dev/null 2>&1 && alias grep=rg egrep=rg; "
    "command -v fd >/dev/null 2>&1 && alias find=fd && alias glob='fd --glob'; "
    "fi; "
    # Restore the caller's working directory.  Guarded on -d so a since-deleted
    # dir falls back to the image default instead of aborting the command.
    'if [ -n "$OXAGEN_CWD" ] && [ -d "$OXAGEN_CWD" ]; then cd "$OXAGEN_CWD"; fi; '
    'eval "$OXAGEN_EXEC_CMD"; '
    "__oxagen_rc=$?; "
    "printf '\\036__OXAGEN_CWD__=%s' \"$(pwd 2>/dev/null)\"; "
    "exit $__oxagen_rc"
)

RUNNER_SECRET = modal.Secret.from_name("oxagen-runner")

app = modal.App("oxagen-sandbox")
web = FastAPI(title="oxagen-sandbox-runner", version="0.7.0")


def _runner_app() -> "modal.App | None":
    """
    App handle for Sandbox.create. SDK >= 1.4 raises ValueError when handed an
    App whose app_id is unset; None makes it fall back to the implicit container
    app, which is always hydrated inside the deployed runner.
    """
    return app if app.app_id is not None else None


def _internal_error(op: str, exc: Exception) -> HTTPException:
    """
    Convert an unexpected failure into a structured 500. Without this, FastAPI
    returns a bare text "Internal Server Error" and the TS driver surfaces an
    unactionable `modal runner 500 <path>: Internal Server Error`. The runner is
    a token-authed internal service, so echoing the exception is safe and makes
    the driver-side error self-diagnosing; the traceback goes to Modal app logs.
    """
    traceback.print_exc()
    return HTTPException(status_code=500, detail=f"{op} failed: {type(exc).__name__}: {exc}")


def _custom_image(image_ref: str) -> modal.Image:
    """
    Resolve a sandbox-template custom image ref (digest-pinned registry ref,
    e.g. ghcr.io/acme/swe-bench@sha256:…) to a Modal Image.

    add_python=None: the customer image ships its own toolchain — a prewarmed
    eval image must run exactly as published, and the entrypoint commands we
    exec (sh/node/python or the durable `sleep infinity`) only require the
    binaries the template author baked in. Bringing tools (git, runtimes) is
    the template author's responsibility.
    """
    return modal.Image.from_registry(image_ref, add_python=None)


def _resource_kwargs(vcpu: float | None, disk_mb: int | None) -> dict:
    """cpu/ephemeral_disk kwargs for Sandbox.create, omitted when unset."""
    kw: dict = {}
    if vcpu:
        kw["cpu"] = float(vcpu)
    if disk_mb:
        kw["ephemeral_disk"] = int(disk_mb)
    return kw


async def _create_sandbox(*args, **kwargs):
    """
    modal.Sandbox.create with graceful degradation: optional kwargs the
    installed SDK predates (idle_timeout < 1.4.x, ephemeral_disk, cpu) are
    dropped one at a time on TypeError and the create retried — generalizes
    the previous idle_timeout-only try/except so resource params degrade the
    same way instead of failing the run.
    """
    droppable = ("ephemeral_disk", "cpu", "idle_timeout")
    while True:
        try:
            return await modal.Sandbox.create.aio(*args, **kwargs)
        except TypeError:
            drop = next((k for k in droppable if k in kwargs), None)
            if drop is None:
                raise
            kwargs.pop(drop)
            print(f"sandbox create: SDK rejected kwarg {drop!r}; retrying without", file=sys.stderr)


class RunRequest(BaseModel):
    language: Literal["node", "python", "shell"]
    code: str
    stdin: str | None = None
    env: dict[str, str] | None = None
    timeout_ms: int
    memory_mb: int
    network: Literal["allow", "deny"]
    org_id: str
    workspace_id: str
    # Registry image ref (digest-pinned). The driver sends the template's
    # custom image, or the @oxagen/sandbox/images default for the language;
    # None falls back to this runner's built-in LANG_IMAGES.
    image: str | None = None
    vcpu: float | None = None
    disk_mb: int | None = None


class RunResponse(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    oom_killed: bool


# ---------------------------------------------------------------------------
# Durable sandbox lifecycle models
# ---------------------------------------------------------------------------

class SandboxCreateRequest(BaseModel):
    image: Literal["node", "python", "shell", "agent"]
    # Sandbox-template custom image (digest-pinned registry ref). When set it
    # replaces the DURABLE_IMAGES[image] base entirely — the template author
    # ships their own toolchain (git etc.), e.g. a prewarmed eval image.
    image_ref: str | None = None
    memory_mb: int
    vcpu: float | None = None
    disk_mb: int | None = None
    ttl_seconds: int
    idle_timeout_seconds: int
    network: Literal["allow", "deny"]
    org_id: str
    workspace_id: str
    setup_cmd: str | None = None
    # Env injected into the setup_cmd exec ONLY (never persisted in the image).
    # Trusted values (environment vault secrets, template literal_env) resolved
    # by the TypeScript side — the credential channel that lets a setup command
    # clone a private repo. May contain secrets: never echo values into errors.
    setup_env: dict[str, str] | None = None


class SandboxCreateResponse(BaseModel):
    sandbox_id: str
    status: Literal["running"]
    created_at: str  # ISO 8601


class SandboxExecRequest(BaseModel):
    sandbox_id: str
    command: str
    timeout_ms: int
    env: dict[str, str] | None = None
    stdin: str | None = None
    # Working directory to run the command in (durable-terminal cwd persistence).
    # None → the image default. Optional so callers/drivers that predate the
    # field behave exactly as before.
    cwd: str | None = None


class SandboxExecResponse(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    gone: bool  # True when the sandbox has been reaped; caller should snapshot-restore
    # The shell's working directory AFTER the command ran. None when the trailer
    # couldn't be captured (command self-`exit`ed, timed out, or a custom image
    # without the trampoline); the caller then keeps its prior cwd.
    cwd: str | None = None


class SandboxSnapshotRequest(BaseModel):
    sandbox_id: str


class SandboxSnapshotResponse(BaseModel):
    snapshot_id: str  # Modal Image object_id of the filesystem snapshot


class SandboxRestoreRequest(BaseModel):
    snapshot_id: str
    memory_mb: int
    # The restored base image IS the snapshot, so image/image_ref don't apply;
    # resource params from the session spec are honored on the new sandbox.
    vcpu: float | None = None
    disk_mb: int | None = None
    ttl_seconds: int
    idle_timeout_seconds: int
    network: Literal["allow", "deny"]
    org_id: str
    workspace_id: str


class SandboxRestoreResponse(BaseModel):
    sandbox_id: str
    status: Literal["running"]
    created_at: str  # ISO 8601


class SandboxTerminateRequest(BaseModel):
    sandbox_id: str


class SandboxTerminateResponse(BaseModel):
    ok: bool


class SandboxStatusRequest(BaseModel):
    sandbox_id: str


class SandboxStatusResponse(BaseModel):
    sandbox_id: str
    status: Literal["running", "gone"]


def _check_auth(authorization: str | None, expected: str) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):]
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="invalid bearer token")


def decode_output(raw: bytes | str) -> str:
    if isinstance(raw, str):
        return raw
    return raw.decode("utf-8", errors="replace")


def _split_cwd_trailer(stdout: str) -> tuple[str, str | None]:
    """
    Split the RS-delimited cwd trailer `_FAST_ALIAS_TRAMPOLINE` appends to stdout.

    Returns (clean_stdout, cwd).  cwd is None when the trailer is absent — the
    command called `exit` itself so our trailer never ran, a custom template
    image lacks the trampoline, or output was truncated by a timeout.  The
    caller then keeps its prior directory.  rfind() is used so bytes the command
    itself happened to print can never win over our always-last trailer.
    """
    idx = stdout.rfind(_CWD_SENTINEL)
    if idx == -1:
        return stdout, None
    cwd = stdout[idx + len(_CWD_SENTINEL):].strip() or None
    return stdout[:idx], cwd


async def _run_sandbox(req: RunRequest) -> RunResponse:
    """
    Execute user code in a Modal Sandbox (Firecracker microVM).

    We create a single sandbox and run two sequential exec() calls in it:
      1. Stage: `sh -c 'mkdir -p /work && base64 -d > /work/<file>'`
         — receives base64-encoded code on stdin, writes the source file.
      2. Execute: the language runtime (node/python/sh) runs the file.

    base64 encoding is used so arbitrary user code (with quotes, backslashes,
    newlines) is safe to pipe through stdin without any shell escaping.
    """
    # A driver-supplied registry ref (template custom image or the pinned
    # @oxagen/sandbox/images default) wins; LANG_IMAGES is the fallback for
    # drivers that predate the field.
    image = _custom_image(req.image) if req.image else LANG_IMAGES.get(req.language)
    if image is None:
        raise HTTPException(status_code=400, detail=f"unsupported language {req.language!r}")

    filename, argv = LANG_ENTRY[req.language]
    block_network = req.network == "deny"
    sandbox_timeout = max(30, req.timeout_ms // 1000 + 10)

    # Base64-encode the source so it's safe to pipe to stdin.
    code_b64 = base64.b64encode(req.code.encode("utf-8")).decode("ascii") + "\n"

    # Create sandbox — stays alive for both the staging and execution phases.
    # We use a long-running `sleep` as the sandbox entrypoint so it stays up
    # between exec() calls; exec() spawns child processes inside it.
    sb = await _create_sandbox(
        "sleep", str(sandbox_timeout + 30),
        image=image,
        memory=req.memory_mb,
        timeout=sandbox_timeout + 30,
        block_network=block_network,
        app=_runner_app(),
        **_resource_kwargs(req.vcpu, req.disk_mb),
    )

    started = time.monotonic()
    timed_out = False
    oom_killed = False
    exit_code = 0
    stdout_str = ""
    stderr_str = ""

    try:
        # ── Phase 1: Stage the source file ─────────────────────────────────
        stage_proc = await modal.Sandbox.exec.aio(
            sb,
            "sh", "-c", f"mkdir -p /work && base64 -d > /work/{filename}",
        )
        # Write base64-encoded code to stdin (sync write, async drain).
        stage_proc.stdin.write(code_b64)
        stage_proc.stdin.write_eof()
        await stage_proc.stdin.drain.aio()
        await stage_proc.wait.aio()

        # ── Phase 2: Execute the code ────────────────────────────────────────
        exec_env: dict[str, str] | None = req.env if req.env else None
        exec_proc = await modal.Sandbox.exec.aio(
            sb,
            *argv,
            env=exec_env,
        )

        if req.stdin:
            exec_proc.stdin.write(req.stdin)
            exec_proc.stdin.write_eof()
            await exec_proc.stdin.drain.aio()

        # Race the wait against the logical timeout.
        wait_task = asyncio.create_task(exec_proc.wait.aio())
        done, _ = await asyncio.wait([wait_task], timeout=req.timeout_ms / 1000)

        if not done:
            timed_out = True
            exit_code = 124  # Match Modal's timeout convention.
            wait_task.cancel()
        else:
            exit_code = wait_task.result()
            oom_killed = exit_code == 137

        # Read output — after wait() so all output is flushed.
        stdout_raw = await exec_proc.stdout.read.aio()
        stderr_raw = await exec_proc.stderr.read.aio()
        stdout_str = decode_output(stdout_raw)
        stderr_str = decode_output(stderr_raw)

    finally:
        try:
            await modal.Sandbox.terminate.aio(sb)
        except Exception:
            pass

    duration_ms = int((time.monotonic() - started) * 1000)
    return RunResponse(
        exit_code=exit_code,
        stdout=stdout_str,
        stderr=stderr_str,
        duration_ms=duration_ms,
        timed_out=timed_out,
        oom_killed=oom_killed,
    )


@web.post("/run", response_model=RunResponse)
async def run(req: RunRequest, authorization: str | None = Header(default=None)) -> RunResponse:
    _check_auth(authorization, os.environ["MODAL_RUNNER_TOKEN"])
    try:
        return await _run_sandbox(req)
    except HTTPException:
        raise
    except Exception as exc:
        raise _internal_error("run", exc) from exc


@web.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Helpers shared by durable endpoints
# ---------------------------------------------------------------------------

async def _sandbox_from_id(sandbox_id: str) -> "modal.Sandbox":
    """
    Reconnect to an existing Modal Sandbox by its object_id.

    modal.Sandbox.from_id is a synchronous factory in SDK 1.4.x (it does not
    have an .aio wrapper); it creates a lazy handle and may raise only when the
    handle is first used.  We attempt the .aio path first, fall back to sync.
    """
    if hasattr(modal.Sandbox.from_id, "aio"):
        return await modal.Sandbox.from_id.aio(sandbox_id)  # type: ignore[attr-defined]
    return modal.Sandbox.from_id(sandbox_id)


# ---------------------------------------------------------------------------
# POST /sandbox/create
# ---------------------------------------------------------------------------

@web.post("/sandbox/create", response_model=SandboxCreateResponse)
async def sandbox_create(
    req: SandboxCreateRequest,
    authorization: str | None = Header(default=None),
) -> SandboxCreateResponse:
    """
    Create a durable Modal Sandbox that persists across HTTP requests.

    The sandbox entrypoint is `sleep infinity` so it stays alive; subsequent
    calls to /sandbox/exec reconnect via Sandbox.from_id.

    idle_timeout is passed if the installed modal SDK >= 1.4.x accepts it;
    we guard with try/except TypeError and retry without it on older SDKs.
    """
    _check_auth(authorization, os.environ["MODAL_RUNNER_TOKEN"])

    # A template custom image replaces the durable base entirely (§ sandbox
    # templates); the kind-keyed DURABLE_IMAGES remain the default path.
    if req.image_ref:
        image = _custom_image(req.image_ref)
    else:
        image = DURABLE_IMAGES.get(req.image)
    if image is None:
        raise HTTPException(status_code=400, detail=f"unsupported image kind {req.image!r}")

    block_network = req.network == "deny"

    try:
        sb = await _create_sandbox(
            "sleep", "infinity",
            image=image,
            memory=req.memory_mb,
            timeout=req.ttl_seconds,
            block_network=block_network,
            idle_timeout=req.idle_timeout_seconds,
            app=_runner_app(),
            **_resource_kwargs(req.vcpu, req.disk_mb),
        )
    except Exception as exc:
        raise _internal_error("sandbox create", exc) from exc

    # Run setup_cmd once to prepare the image (e.g. install deps, clone repo).
    # If it fails, terminate the sandbox and surface the error.
    if req.setup_cmd:
        # GIT_TERMINAL_PROMPT=0 (overridable via setup_env) makes an
        # unauthenticated clone of a private repo fail fast with git's clear
        # "terminal prompts disabled" message instead of the cryptic
        # "could not read Username …: No such device or address" a TTY-less
        # exec produces when git tries to prompt.
        setup_env = {"GIT_TERMINAL_PROMPT": "0", **(req.setup_env or {})}
        try:
            setup_proc = await modal.Sandbox.exec.aio(
                sb, "sh", "-c", req.setup_cmd, env=setup_env
            )
            setup_exit = await setup_proc.wait.aio()
            setup_stderr = (
                decode_output(await setup_proc.stderr.read.aio()) if setup_exit != 0 else ""
            )
        except Exception as exc:
            try:
                await modal.Sandbox.terminate.aio(sb)
            except Exception:
                pass
            raise _internal_error("sandbox setup_cmd", exc) from exc
        if setup_exit != 0:
            try:
                await modal.Sandbox.terminate.aio(sb)
            except Exception:
                pass
            # 422, not 500: a failing caller-authored setup command is a
            # request problem, not runner ill-health — keep 5xx meaningful
            # for paging/alerting.
            raise HTTPException(
                status_code=422,
                detail=f"setup_cmd exited {setup_exit}: {setup_stderr}",
            )

    return SandboxCreateResponse(
        sandbox_id=sb.object_id,
        status="running",
        created_at=datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# POST /sandbox/exec
# ---------------------------------------------------------------------------

@web.post("/sandbox/exec", response_model=SandboxExecResponse)
async def sandbox_exec(
    req: SandboxExecRequest,
    authorization: str | None = Header(default=None),
) -> SandboxExecResponse:
    """
    Run a shell command inside an existing durable sandbox.

    Returns gone:true (HTTP 200, not 500) when the sandbox has been reaped —
    the TypeScript caller uses this signal to trigger a snapshot-restore cycle.
    The sandbox is NOT terminated after exec so state is preserved for the
    next call.
    """
    _check_auth(authorization, os.environ["MODAL_RUNNER_TOKEN"])

    # Reconnect; surface gone:true for any connection-level failure.
    try:
        sb = await _sandbox_from_id(req.sandbox_id)
    except Exception:
        return SandboxExecResponse(
            exit_code=-1,
            stdout="",
            stderr="sandbox gone",
            duration_ms=0,
            timed_out=False,
            gone=True,
        )

    started = time.monotonic()
    timed_out = False

    try:
        # Route through the alias trampoline: the agent's command rides in
        # $OXAGEN_EXEC_CMD (env transport also sidesteps argv quoting issues)
        # and is eval'd after grep→rg / find→fd / glob aliases are defined.
        # OXAGEN_CWD restores the caller's working directory so `cd` persists
        # across exec calls (durable-terminal cwd persistence).
        exec_env = dict(req.env or {})
        exec_env["OXAGEN_EXEC_CMD"] = req.command
        if req.cwd:
            exec_env["OXAGEN_CWD"] = req.cwd
        p = await modal.Sandbox.exec.aio(
            sb,
            "sh", "-c", _FAST_ALIAS_TRAMPOLINE,
            env=exec_env,
        )

        if req.stdin:
            p.stdin.write(req.stdin)
            p.stdin.write_eof()
            await p.stdin.drain.aio()

        # Race the process against the caller's timeout.
        wait_task = asyncio.create_task(p.wait.aio())
        done, _ = await asyncio.wait([wait_task], timeout=req.timeout_ms / 1000)

        if not done:
            timed_out = True
            exit_code = 124  # Match Modal's timeout convention.
            wait_task.cancel()
        else:
            exit_code = wait_task.result()

        # Peel the cwd trailer off stdout before returning it to the caller.
        stdout_str, result_cwd = _split_cwd_trailer(
            decode_output(await p.stdout.read.aio())
        )
        stderr_str = decode_output(await p.stderr.read.aio())

    except Exception as exc:
        # Exec-level failure (e.g. sandbox reaped between from_id and exec).
        return SandboxExecResponse(
            exit_code=-1,
            stdout="",
            stderr=f"exec error: {exc}",
            duration_ms=int((time.monotonic() - started) * 1000),
            timed_out=False,
            gone=True,
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    return SandboxExecResponse(
        exit_code=exit_code,
        stdout=stdout_str,
        stderr=stderr_str,
        duration_ms=duration_ms,
        timed_out=timed_out,
        gone=False,
        cwd=result_cwd,
    )


# ---------------------------------------------------------------------------
# POST /sandbox/snapshot
# ---------------------------------------------------------------------------

@web.post("/sandbox/snapshot", response_model=SandboxSnapshotResponse)
async def sandbox_snapshot(
    req: SandboxSnapshotRequest,
    authorization: str | None = Header(default=None),
) -> SandboxSnapshotResponse:
    """
    Snapshot the filesystem of a running sandbox into a Modal Image.

    The returned snapshot_id is a Modal Image object_id; pass it to
    /sandbox/restore to spin up a new sandbox from that state.

    NOTE: do not call this while an exec is in flight — the filesystem
    state will be inconsistent.

    modal.Sandbox.snapshot_filesystem is available in SDK >= 0.67 (approx).
    We try both the .aio wrapper and the sync path; 500 if unsupported.
    """
    _check_auth(authorization, os.environ["MODAL_RUNNER_TOKEN"])

    try:
        sb = await _sandbox_from_id(req.sandbox_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"sandbox not found: {exc}") from exc

    try:
        snap_fn = getattr(sb, "snapshot_filesystem", None)
        if snap_fn is None:
            raise HTTPException(
                status_code=501,
                detail="snapshot_filesystem not available in this modal SDK version",
            )
        # Try async path first; fall back to sync.
        if hasattr(snap_fn, "aio"):
            img = await snap_fn.aio()
        else:
            img = snap_fn()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"snapshot failed: {exc}",
        ) from exc

    return SandboxSnapshotResponse(snapshot_id=img.object_id)


# ---------------------------------------------------------------------------
# POST /sandbox/restore
# ---------------------------------------------------------------------------

@web.post("/sandbox/restore", response_model=SandboxRestoreResponse)
async def sandbox_restore(
    req: SandboxRestoreRequest,
    authorization: str | None = Header(default=None),
) -> SandboxRestoreResponse:
    """
    Create a new sandbox from a previously snapshotted filesystem image.

    modal.Image.from_id reconstructs an Image handle from its object_id so we
    can use the snapshot as the sandbox base image.
    """
    _check_auth(authorization, os.environ["MODAL_RUNNER_TOKEN"])

    # Reconstruct the Image from the snapshot id.
    # modal.Image.from_id is synchronous in SDK 1.4.x.
    try:
        img = modal.Image.from_id(req.snapshot_id)
    except Exception as exc:
        raise HTTPException(
            status_code=404,
            detail=f"snapshot not found: {exc}",
        ) from exc

    block_network = req.network == "deny"

    try:
        sb = await _create_sandbox(
            "sleep", "infinity",
            image=img,
            memory=req.memory_mb,
            timeout=req.ttl_seconds,
            block_network=block_network,
            idle_timeout=req.idle_timeout_seconds,
            app=_runner_app(),
            **_resource_kwargs(req.vcpu, req.disk_mb),
        )
    except Exception as exc:
        raise _internal_error("sandbox restore", exc) from exc

    return SandboxRestoreResponse(
        sandbox_id=sb.object_id,
        status="running",
        created_at=datetime.now(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# POST /sandbox/terminate
# ---------------------------------------------------------------------------

@web.post("/sandbox/terminate", response_model=SandboxTerminateResponse)
async def sandbox_terminate(
    req: SandboxTerminateRequest,
    authorization: str | None = Header(default=None),
) -> SandboxTerminateResponse:
    """
    Terminate a durable sandbox.  Swallows "already gone" errors so callers
    can safely call terminate even on sandboxes that have already been reaped.
    """
    _check_auth(authorization, os.environ["MODAL_RUNNER_TOKEN"])

    try:
        sb = await _sandbox_from_id(req.sandbox_id)
        await modal.Sandbox.terminate.aio(sb)
    except Exception:
        # Already gone or never existed — that's fine; still return ok:true.
        pass

    return SandboxTerminateResponse(ok=True)


# ---------------------------------------------------------------------------
# POST /sandbox/status
# ---------------------------------------------------------------------------

@web.post("/sandbox/status", response_model=SandboxStatusResponse)
async def sandbox_status(
    req: SandboxStatusRequest,
    authorization: str | None = Header(default=None),
) -> SandboxStatusResponse:
    """
    Report whether a durable sandbox is still running.

    from_id creates a lazy handle; if poll() is available (SDK >= 0.67 approx)
    we call it — None means still running, any int means exited/gone.
    If from_id itself raises, the sandbox is gone.
    """
    _check_auth(authorization, os.environ["MODAL_RUNNER_TOKEN"])

    try:
        sb = await _sandbox_from_id(req.sandbox_id)
        # poll() returns None if the sandbox is still alive, or an exit code if done.
        poll_fn = getattr(sb, "poll", None)
        if poll_fn is not None and callable(poll_fn):
            poll_result = poll_fn()
            status: Literal["running", "gone"] = "gone" if poll_result is not None else "running"
        else:
            # poll() not available in this SDK version; trust that from_id succeeded.
            status = "running"
    except Exception:
        status = "gone"

    return SandboxStatusResponse(sandbox_id=req.sandbox_id, status=status)


# copy=True bakes browser/ into the runner image at deploy time (when the repo
# files exist) so _browser_asset can hydrate the durable "agent" image from
# /assets/browser inside the running container.
@app.function(
    secrets=[RUNNER_SECRET],
    image=modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi", "pydantic")
    .add_local_dir(str(_BROWSER_SRC_DIR), remote_path="/assets/browser", copy=True),
)
@modal.asgi_app()
def fastapi_app() -> FastAPI:
    return web
