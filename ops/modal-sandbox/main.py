"""
Local development shim for the Oxagen sandbox runner.

Runs a lightweight HTTP server on port 7799 (matching MODAL_RUNNER_URL in
.env) that responds to the same POST /run and GET /healthz contract as the
real Modal runner (runner.py), but executes code in a subprocess instead of
a Modal Firecracker microVM.

Use this for local development when:
  - You do not have a Modal account or deployment yet.
  - You want fast iteration without a round-trip to Modal's cloud.

WARNING: This shim has NO sandboxing — code runs directly in the local Python
process as a subprocess. Never expose this server to the network. It is
strictly a developer-convenience tool for localhost use.

Usage:
  cd ops/modal-sandbox
  uv run main.py            # starts on http://localhost:7799
  # In another terminal:
  curl http://localhost:7799/healthz  # → {"status":"ok"}

The root .env.local must have:
  MODAL_RUNNER_URL=http://localhost:7799   ← use this for local shim
  MODAL_RUNNER_TOKEN=<value from ops/modal-sandbox/.env>
  SANDBOX_DRIVER=modal
  SANDBOX_ENABLED=true

For production (real Modal deployment at
https://oxagenai--oxagen-sandbox-fastapi-app.modal.run), set
MODAL_RUNNER_URL to that URL in Vercel env vars instead.
"""
from __future__ import annotations

import hmac
import os
import secrets
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

# fastapi + uvicorn are in pyproject.toml dependencies.
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

TOKEN = os.environ.get("MODAL_RUNNER_TOKEN", "")
PORT = int(os.environ.get("PORT", "7799"))

web = FastAPI(title="oxagen-sandbox-local-shim", version="0.4.0")

LANG_EXT: dict[str, str] = {
    "node": "js",
    "python": "py",
    "shell": "sh",
}

LANG_CMD: dict[str, list[str]] = {
    "node":   ["node"],
    "python": ["python3"],
    "shell":  ["/bin/sh"],
}


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
    image: str | None = None


class RunResponse(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    oom_killed: bool


# ---------------------------------------------------------------------------
# Durable sandbox state — in-process dicts (dev-only, not persisted across
# restarts).  sandbox_id → { "dir": str, "created_at": str }
# snapshot_id  → { "dir": str }   (copy of the session dir at snapshot time)
# ---------------------------------------------------------------------------

SESSIONS: dict[str, dict] = {}
SNAPSHOTS: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Durable sandbox lifecycle models (shared request/response contract with
# the production runner.py so TS callers need no changes between envs).
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
    gone: bool


class SandboxSnapshotRequest(BaseModel):
    sandbox_id: str


class SandboxSnapshotResponse(BaseModel):
    snapshot_id: str


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


def _check_auth(authorization: str | None) -> None:
    if not TOKEN:
        raise HTTPException(status_code=500, detail="MODAL_RUNNER_TOKEN not set in environment")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    given = authorization[len("Bearer "):]
    if not hmac.compare_digest(given, TOKEN):
        raise HTTPException(status_code=401, detail="invalid bearer token")


@web.post("/run", response_model=RunResponse)
async def run(req: RunRequest, authorization: str | None = Header(default=None)) -> RunResponse:
    _check_auth(authorization)

    ext = LANG_EXT.get(req.language)
    cmd_prefix = LANG_CMD.get(req.language)
    if ext is None or cmd_prefix is None:
        raise HTTPException(status_code=400, detail=f"unsupported language {req.language!r}")

    env = {**os.environ, **(req.env or {})}

    with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False, mode="w") as f:
        f.write(req.code)
        code_path = f.name

    started = time.monotonic()
    timed_out = False
    oom_killed = False
    try:
        result = subprocess.run(
            [*cmd_prefix, code_path],
            input=req.stdin,
            capture_output=True,
            text=True,
            timeout=req.timeout_ms / 1000,
            env=env,
        )
        exit_code = result.returncode
        stdout = result.stdout
        stderr = result.stderr
        # Match Modal's OOM convention (exit 137 = SIGKILL).
        oom_killed = exit_code == 137
    except subprocess.TimeoutExpired as e:
        timed_out = True
        exit_code = 124  # Match Modal's timeout convention.
        stdout = (e.stdout or b"").decode("utf-8", errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        stderr = (e.stderr or b"").decode("utf-8", errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
    finally:
        Path(code_path).unlink(missing_ok=True)

    duration_ms = int((time.monotonic() - started) * 1000)
    return RunResponse(
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        duration_ms=duration_ms,
        timed_out=timed_out,
        oom_killed=oom_killed,
    )


@web.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# POST /sandbox/create
# ---------------------------------------------------------------------------

@web.post("/sandbox/create", response_model=SandboxCreateResponse)
async def sandbox_create(
    req: SandboxCreateRequest,
    authorization: str | None = Header(default=None),
) -> SandboxCreateResponse:
    """
    Local shim: creates a persistent temp directory as the session working dir.

    image/memory_mb/ttl_seconds/idle_timeout_seconds/network are accepted and
    silently ignored (no real isolation — dev-only).  setup_cmd is executed
    once in the dir so dependencies can be installed during local testing.
    """
    _check_auth(authorization)

    work_dir = tempfile.mkdtemp(prefix="oxagen-sbx-")
    sandbox_id = "local-" + secrets.token_hex(8)
    created_at = datetime.now(timezone.utc).isoformat()

    if req.setup_cmd:
        result = subprocess.run(
            ["/bin/sh", "-c", req.setup_cmd],
            cwd=work_dir,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise HTTPException(
                status_code=500,
                detail=f"setup_cmd exited {result.returncode}: {result.stderr}",
            )

    SESSIONS[sandbox_id] = {"dir": work_dir, "created_at": created_at}

    return SandboxCreateResponse(
        sandbox_id=sandbox_id,
        status="running",
        created_at=created_at,
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
    Local shim: run a shell command in the session's persistent cwd.

    The persistent cwd is what provides cross-call state (clone in call 1,
    build in call 2, etc.).  Returns gone:true if the session is not found
    so the caller can trigger a snapshot-restore cycle, matching prod behaviour.
    """
    _check_auth(authorization)

    session = SESSIONS.get(req.sandbox_id)
    if session is None:
        return SandboxExecResponse(
            exit_code=-1,
            stdout="",
            stderr="sandbox gone",
            duration_ms=0,
            timed_out=False,
            gone=True,
        )

    work_dir = session["dir"]
    env = {**os.environ, **(req.env or {})}
    started = time.monotonic()
    timed_out = False

    try:
        result = subprocess.run(
            ["/bin/sh", "-c", req.command],
            cwd=work_dir,
            input=req.stdin,
            capture_output=True,
            text=True,
            timeout=req.timeout_ms / 1000,
            env=env,
        )
        exit_code = result.returncode
        stdout = result.stdout
        stderr = result.stderr
    except subprocess.TimeoutExpired as e:
        timed_out = True
        exit_code = 124
        stdout = (
            (e.stdout or b"").decode("utf-8", errors="replace")
            if isinstance(e.stdout, bytes)
            else (e.stdout or "")
        )
        stderr = (
            (e.stderr or b"").decode("utf-8", errors="replace")
            if isinstance(e.stderr, bytes)
            else (e.stderr or "")
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    return SandboxExecResponse(
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
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
    Local shim: copy the session directory into a snapshot directory.

    The snapshot_id maps to the copied path in the module-level SNAPSHOTS dict.
    """
    _check_auth(authorization)

    session = SESSIONS.get(req.sandbox_id)
    if session is None:
        raise HTTPException(status_code=404, detail="sandbox not found")

    snapshot_id = "snap-" + secrets.token_hex(8)
    snap_dir = tempfile.mkdtemp(prefix="oxagen-snap-")
    # copytree requires the destination to not exist.
    shutil.rmtree(snap_dir)
    shutil.copytree(session["dir"], snap_dir)

    SNAPSHOTS[snapshot_id] = {"dir": snap_dir}

    return SandboxSnapshotResponse(snapshot_id=snapshot_id)


# ---------------------------------------------------------------------------
# POST /sandbox/restore
# ---------------------------------------------------------------------------

@web.post("/sandbox/restore", response_model=SandboxRestoreResponse)
async def sandbox_restore(
    req: SandboxRestoreRequest,
    authorization: str | None = Header(default=None),
) -> SandboxRestoreResponse:
    """
    Local shim: copy the snapshot directory into a fresh session directory.

    Returns a new sandbox_id.  memory_mb/ttl/idle_timeout/network are accepted
    and ignored (no real isolation).
    """
    _check_auth(authorization)

    snap = SNAPSHOTS.get(req.snapshot_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="snapshot not found")

    sandbox_id = "local-" + secrets.token_hex(8)
    created_at = datetime.now(timezone.utc).isoformat()
    work_dir = tempfile.mkdtemp(prefix="oxagen-sbx-")
    shutil.rmtree(work_dir)
    shutil.copytree(snap["dir"], work_dir)

    SESSIONS[sandbox_id] = {"dir": work_dir, "created_at": created_at}

    return SandboxRestoreResponse(
        sandbox_id=sandbox_id,
        status="running",
        created_at=created_at,
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
    Local shim: delete the session directory and remove it from SESSIONS.

    Swallows "already gone" errors so callers can safely terminate twice.
    """
    _check_auth(authorization)

    session = SESSIONS.pop(req.sandbox_id, None)
    if session is not None:
        shutil.rmtree(session["dir"], ignore_errors=True)

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
    Local shim: "running" if the sandbox_id is still in SESSIONS, else "gone".
    """
    _check_auth(authorization)

    status: Literal["running", "gone"] = "running" if req.sandbox_id in SESSIONS else "gone"
    return SandboxStatusResponse(sandbox_id=req.sandbox_id, status=status)


if __name__ == "__main__":
    if not TOKEN:
        print("WARNING: MODAL_RUNNER_TOKEN is not set. Set it before starting.")
    print(f"Starting local sandbox shim on http://localhost:{PORT}")
    print("This shim has NO sandboxing — for local development only.")
    uvicorn.run(web, host="0.0.0.0", port=PORT, log_level="info")
