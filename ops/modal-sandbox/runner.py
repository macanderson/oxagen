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
import time
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

RUNNER_SECRET = modal.Secret.from_name("oxagen-runner")

app = modal.App("oxagen-sandbox")
web = FastAPI(title="oxagen-sandbox-runner", version="0.3.0")


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


@app.function(
    secrets=[RUNNER_SECRET],
    image=modal.Image.debian_slim(python_version="3.12").pip_install("fastapi", "pydantic"),
)
@modal.asgi_app()
def fastapi_app() -> FastAPI:
    return web
