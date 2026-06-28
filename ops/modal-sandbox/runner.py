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
from datetime import datetime, timezone
from typing import Literal

import modal
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Image catalog — keyed by language enum.
# The Node driver sends the language enum; we map it to a Modal Image.
# ---------------------------------------------------------------------------

LANG_IMAGES: dict[str, modal.Image] = {
    "node":   modal.Image.from_registry("node:20-alpine", add_python=None),
    "python": modal.Image.debian_slim(python_version="3.12"),
    "shell":  modal.Image.from_registry("alpine:3.20", add_python=None),
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
    "node":   modal.Image.from_registry("node:20").apt_install("git"),
    "python": modal.Image.debian_slim(python_version="3.12").apt_install("git"),
    "shell":  modal.Image.debian_slim(python_version="3.12").apt_install("git"),
    # "agent" = Debian slim + Python 3.12 + git + curl + Playwright/Chromium.
    # add_local_file(local_path, remote_path, copy=True) bakes the file into the
    # image layer at build time (copy=True is required so the subsequent chmod
    # run_commands step can see the files).  Local paths are resolved relative to
    # the cwd where `modal deploy runner.py` is invoked (ops/modal-sandbox/).
    "agent": (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("git", "curl")
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
        .add_local_file("browser/browserd.py", "/usr/local/bin/browserd", copy=True)
        .add_local_file("browser/browserctl.py", "/usr/local/bin/browserctl", copy=True)
        .run_commands("chmod +x /usr/local/bin/browserd /usr/local/bin/browserctl")
    ),
}

RUNNER_SECRET = modal.Secret.from_name("oxagen-runner")

app = modal.App("oxagen-sandbox")
web = FastAPI(title="oxagen-sandbox-runner", version="0.4.0")


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
    image: str | None = None  # accepted for forward-compat, derived from language


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
    memory_mb: int
    ttl_seconds: int
    idle_timeout_seconds: int
    network: Literal["allow", "deny"]
    org_id: str
    workspace_id: str
    setup_cmd: str | None = None


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


class SandboxExecResponse(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    gone: bool  # True when the sandbox has been reaped; caller should snapshot-restore


class SandboxSnapshotRequest(BaseModel):
    sandbox_id: str


class SandboxSnapshotResponse(BaseModel):
    snapshot_id: str  # Modal Image object_id of the filesystem snapshot


class SandboxRestoreRequest(BaseModel):
    snapshot_id: str
    memory_mb: int
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
    image = LANG_IMAGES.get(req.language)
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
    sb = await modal.Sandbox.create.aio(
        "sleep", str(sandbox_timeout + 30),
        image=image,
        memory=req.memory_mb,
        timeout=sandbox_timeout + 30,
        block_network=block_network,
        app=app,
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
    return await _run_sandbox(req)


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

    image = DURABLE_IMAGES.get(req.image)
    if image is None:
        raise HTTPException(status_code=400, detail=f"unsupported image kind {req.image!r}")

    block_network = req.network == "deny"

    # Attempt create with idle_timeout; fall back gracefully for older SDKs.
    try:
        sb = await modal.Sandbox.create.aio(
            "sleep", "infinity",
            image=image,
            memory=req.memory_mb,
            timeout=req.ttl_seconds,
            block_network=block_network,
            idle_timeout=req.idle_timeout_seconds,
            app=app,
        )
        print("sandbox/create: created with idle_timeout", file=sys.stderr)
    except TypeError:
        # Older SDK does not accept idle_timeout keyword argument.
        sb = await modal.Sandbox.create.aio(
            "sleep", "infinity",
            image=image,
            memory=req.memory_mb,
            timeout=req.ttl_seconds,
            block_network=block_network,
            app=app,
        )
        print("sandbox/create: created without idle_timeout (SDK too old)", file=sys.stderr)

    # Run setup_cmd once to prepare the image (e.g. install deps, clone repo).
    # If it fails, terminate the sandbox and surface the error.
    if req.setup_cmd:
        setup_proc = await modal.Sandbox.exec.aio(sb, "sh", "-c", req.setup_cmd)
        setup_exit = await setup_proc.wait.aio()
        if setup_exit != 0:
            setup_stderr = decode_output(await setup_proc.stderr.read.aio())
            try:
                await modal.Sandbox.terminate.aio(sb)
            except Exception:
                pass
            raise HTTPException(
                status_code=500,
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
        p = await modal.Sandbox.exec.aio(
            sb,
            "sh", "-c", req.command,
            env=req.env or None,
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

        stdout_str = decode_output(await p.stdout.read.aio())
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
        sb = await modal.Sandbox.create.aio(
            "sleep", "infinity",
            image=img,
            memory=req.memory_mb,
            timeout=req.ttl_seconds,
            block_network=block_network,
            idle_timeout=req.idle_timeout_seconds,
            app=app,
        )
        print("sandbox/restore: created with idle_timeout", file=sys.stderr)
    except TypeError:
        sb = await modal.Sandbox.create.aio(
            "sleep", "infinity",
            image=img,
            memory=req.memory_mb,
            timeout=req.ttl_seconds,
            block_network=block_network,
            app=app,
        )
        print("sandbox/restore: created without idle_timeout (SDK too old)", file=sys.stderr)

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


@app.function(
    secrets=[RUNNER_SECRET],
    image=modal.Image.debian_slim(python_version="3.12").pip_install("fastapi", "pydantic"),
)
@modal.asgi_app()
def fastapi_app() -> FastAPI:
    return web
