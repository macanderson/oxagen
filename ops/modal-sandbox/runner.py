# pyright: reportMissingImports=false, reportAttributeAccessIssue=false
"""
Oxagen sandbox runner — deployed to Modal as a single FastAPI app.

Pyright is silenced above because modal + fastapi are installed inside
the Modal image at deploy time, not in the repo's local toolchain.

This is the *only* Python in the v2 stack. It exists because Modal's first-
class sandbox primitives (Sandbox.create, sb.exec, sb.terminate) are Python-
SDK-native; running them from Node would mean wrapping the gRPC client by
hand. A 100-line Python shim is cheaper and inherits Modal's pool warmer,
egress controls, and per-second billing.

Contract:
  POST /run
    headers: authorization: Bearer <MODAL_RUNNER_TOKEN>
    body:    { language, code, stdin?, env?, timeout_ms, memory_mb,
               network, org_id, workspace_id, image }
    returns: { exit_code, stdout, stderr, duration_ms, timed_out, oom_killed }

  GET /healthz
    returns: { status: "ok" }

Deploy:
  cd ops/modal-sandbox
  uv run modal token new              # first time only — opens browser
  uv run modal secret create oxagen-runner MODAL_RUNNER_TOKEN=<paste-value>
  uv run modal deploy runner.py       # prints the public URL on success

  Wire the printed URL + token into Vercel and .env.local:
    MODAL_RUNNER_URL   = https://<workspace>--oxagen-sandbox-fastapi-app.modal.run
    MODAL_RUNNER_TOKEN = <same token>
    SANDBOX_DRIVER     = modal
    SANDBOX_ENABLED    = true

Health check:
  curl "$MODAL_RUNNER_URL/healthz"   # → {"status":"ok"}

Free tier:
  Modal grants $30/month of compute credits with no card on file. At our
  default limits (512 MB, 30s) a single run costs ~$0.0003, so the free
  tier carries early production. Switch to PAYG when usage justifies it.
"""

from __future__ import annotations

import time
from typing import Literal

import modal
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Image catalog — keyed by language enum, not by mutable tag string.
#
# The Node driver (@oxagen/sandbox/src/modal.ts) sends the language enum
# ("node" | "python" | "shell") in the request body. We map language → Modal
# Image here so Modal can pre-build and warm-pool the image, rather than
# pulling from Docker Hub on every cold start.
#
# The docker driver uses digest-pinned OCI refs (e.g. "node@sha256:…") for
# its own image pulling; those refs are NOT sent over the HTTP boundary.
# The `image` field in the request body is kept for forward-compat (in case
# a caller wants to select an image by tag in future) but the runner always
# derives the Modal Image from `language` first.
# ---------------------------------------------------------------------------

LANG_IMAGES: dict[str, modal.Image] = {
    "node": modal.Image.from_registry("node:20-alpine", add_python=None),
    "python": modal.Image.debian_slim(python_version="3.12"),
    "shell": modal.Image.from_registry("alpine:3.20", add_python=None),
}

LANG_ENTRY: dict[str, tuple[str, list[str]]] = {
    # (filename_in_workdir, argv_template)
    "node":   ("main.js",  ["node", "/work/main.js"]),
    "python": ("main.py",  ["python", "/work/main.py"]),
    "shell":  ("main.sh",  ["/bin/sh", "/work/main.sh"]),
}

# The shared secret is created out-of-band: `uv run modal secret create oxagen-runner`
RUNNER_SECRET = modal.Secret.from_name("oxagen-runner")

app = modal.App("oxagen-sandbox")
web = FastAPI(title="oxagen-sandbox-runner", version="0.2.0")


class RunRequest(BaseModel):
    language: Literal["node", "python", "shell"]
    code: str
    stdin: str | None = None
    env: dict[str, str] | None = None
    timeout_ms: int
    memory_mb: int
    network: Literal["allow", "deny"]
    # org_id and workspace_id are forwarded for per-tenant audit logging.
    # (Previously named tenant_id — corrected to match the TS driver.)
    org_id: str
    workspace_id: str
    # image field is accepted for forward-compat but ignored; the runner
    # derives the Modal Image from the `language` enum (see LANG_IMAGES).
    image: str | None = None


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
    # Constant-time comparison to guard against timing attacks.
    import hmac
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="invalid bearer token")


@web.post("/run", response_model=RunResponse)
async def run(req: RunRequest, authorization: str | None = Header(default=None)) -> RunResponse:
    import os

    _check_auth(authorization, os.environ["MODAL_RUNNER_TOKEN"])

    image = LANG_IMAGES.get(req.language)
    if image is None:
        raise HTTPException(status_code=400, detail=f"unsupported language {req.language!r}")

    filename, argv = LANG_ENTRY[req.language]

    # Sandbox is the Modal primitive that maps 1:1 to a Firecracker microVM
    # with a fresh rootfs, capped CPU/RAM, and an optional egress block.
    # We mount no host paths and stage the code via stdin → tee → exec so the
    # rootfs stays read-only between runs.
    block_network = req.network == "deny"
    sb = await modal.Sandbox.create.aio(
        "sh",
        "-c",
        f"mkdir -p /work && cat > /work/{filename} && chmod +x /work/{filename}",
        image=image,
        memory=req.memory_mb,
        # Give the sandbox a few extra seconds beyond the logical timeout so
        # the runner can report the timeout cleanly instead of being killed
        # mid-response by the Modal platform's own limit.
        timeout=max(30, req.timeout_ms // 1000 + 5),
        block_network=block_network,
        app=app,
    )
    try:
        # Stage the code.
        await sb.stdin.write.aio(req.code.encode("utf-8"))
        await sb.stdin.drain.aio()
        sb.stdin.write_eof()
        await sb.wait.aio()

        # Execute. We capture both streams; Modal handles the timeout / OOM.
        proc = await sb.exec.aio(*argv, timeout=req.timeout_ms / 1000)
        started = time.monotonic()
        if req.stdin:
            await proc.stdin.write.aio(req.stdin.encode("utf-8"))
            await proc.stdin.drain.aio()
            proc.stdin.write_eof()

        stdout_raw = await proc.stdout.read.aio()
        stderr_raw = await proc.stderr.read.aio()
        exit_code = await proc.wait.aio()
        duration_ms = int((time.monotonic() - started) * 1000)

        # Modal surfaces timeouts as exit_code 124 and OOM as 137 (matches
        # the kernel's SIGKILL convention), so we can derive both signals
        # without a side-channel.
        timed_out = exit_code == 124
        oom_killed = exit_code == 137

        def decode(raw: bytes | str) -> str:
            if isinstance(raw, str):
                return raw
            return raw.decode("utf-8", errors="replace")

        return RunResponse(
            exit_code=exit_code,
            stdout=decode(stdout_raw),
            stderr=decode(stderr_raw),
            duration_ms=duration_ms,
            timed_out=timed_out,
            oom_killed=oom_killed,
        )
    finally:
        await sb.terminate.aio()


@web.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.function(
    secrets=[RUNNER_SECRET],
    image=modal.Image.debian_slim().pip_install("fastapi", "pydantic"),
)
@modal.asgi_app()
def fastapi_app() -> FastAPI:
    return web
