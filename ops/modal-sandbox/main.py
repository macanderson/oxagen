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
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Literal

# fastapi + uvicorn are in pyproject.toml dependencies.
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

TOKEN = os.environ.get("MODAL_RUNNER_TOKEN", "")
PORT = int(os.environ.get("PORT", "7799"))

web = FastAPI(title="oxagen-sandbox-local-shim", version="0.2.0")

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


if __name__ == "__main__":
    if not TOKEN:
        print("WARNING: MODAL_RUNNER_TOKEN is not set. Set it before starting.")
    print(f"Starting local sandbox shim on http://localhost:{PORT}")
    print("This shim has NO sandboxing — for local development only.")
    uvicorn.run(web, host="0.0.0.0", port=PORT, log_level="info")
