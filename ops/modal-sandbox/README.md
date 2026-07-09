# Modal sandbox runner

The single Python deliverable in the v2 stack. Deploys to Modal as a FastAPI
ASGI app behind a bearer token; `@oxagen/sandbox`'s Modal driver calls
`POST /run` to spawn a Firecracker microVM, exec the user's code, and
return the captured result.

## Why Modal

- $30/month free compute credits, no card required — covers dev and early
  production at our default 512 MB / 30s limits.
- Sandbox primitive is first-class: fresh rootfs, capped CPU/RAM, network
  block flag, per-second billing.
- Pool warmer is theirs to operate, not ours.

When usage justifies it, the driver swaps to a self-hosted Firecracker pool
on AWS without touching the capability handler — the seam is the HTTP
contract in `runner.py`, not the provider.

## First-time deploy

```bash
# 1. Auth (one-time, opens browser)
pip install modal
modal token new

# 2. Mint the shared secret. Generate a 32-byte random string:
openssl rand -hex 32   # copy the output

# 3. Create the Modal Secret named "oxagen-runner" with key
#    MODAL_RUNNER_TOKEN = <the value from step 2>
modal secret create oxagen-runner MODAL_RUNNER_TOKEN=<paste-here>

# 4. Deploy. Prints the public URL on success.
cd ops/modal-sandbox && uv sync && uv run modal deploy runner.py

# 5. Wire the env on Vercel + .env.local:
#    MODAL_RUNNER_URL   = https://<workspace>--oxagen-sandbox-fastapi-app.modal.run
#    MODAL_RUNNER_TOKEN = <same value as step 2>
#    SANDBOX_DRIVER     = modal
#    SANDBOX_ENABLED    = true
```

## Health check

```bash
curl "$MODAL_RUNNER_URL/healthz"   # → {"status":"ok"}
```

## Redeploy on every runner.py change

The TypeScript driver (`packages/sandbox/src/modal.ts`) ships with every
monorepo deploy, but this runner only updates via `modal deploy` — nothing in
CI ties the two together. If the driver gets a route the deployed runner
doesn't have, every call fails with FastAPI's
`404 {"detail":"Not Found"}` (e.g. `modal runner 404 /sandbox/create`).

Diagnose drift by comparing the deployed spec against `runner.py`:

```bash
curl "$MODAL_RUNNER_URL/openapi.json" | jq '{version: .info.version, routes: (.paths | keys)}'
```

Redeploy (same app name → same URL, additive):

```bash
cd ops/modal-sandbox && uv sync && uv run modal deploy runner.py
```

## Triage: `modal runner 500 <path>: Internal Server Error`

A bare text `Internal Server Error` body (no JSON `detail`) means an
**unhandled exception** escaped the deployed runner — as of v0.7.0 the
create/restore/run endpoints catch these and return
`{"detail":"<op> failed: <ExcType>: <message>"}` instead, so a bare-text 500
also means the deployed runner predates v0.7.0. Steps:

1. Check drift + version via `/openapi.json` (above); redeploy if stale.
2. Read the traceback: `uv run modal app logs oxagen-sandbox`.
3. Known cause (fixed in v0.7.0): `POST /sandbox/create {image:"agent"}` died
   with `FileNotFoundError: local file browser/browserd.py does not exist`.
   The durable `agent` image's `add_local_file` layers hydrate lazily at the
   first `Sandbox.create` — *inside* the runner container, where the repo's
   `browser/` dir doesn't exist. The runner image now bakes `browser/` at
   `/assets/browser` and resolves paths from either location.
4. Other candidates a surfaced detail will now name outright: Modal
   credit/spend-limit exhaustion, registry-image pull failures for
   template `image_ref`s, and SDK kwarg drift.

Unit tests for the HTTP surface (no Modal account needed):

```bash
cd ops/modal-sandbox && uv run --group dev pytest test_runner.py
```

## Cost guardrails

A run at the default limits (Python 3.12, 512 MB, 5 s) costs ~$0.0003 of
Modal credits. The $30 free tier covers ~100k runs/month before any spend.
Per-tenant billing is metered by `@oxagen/billing` from the
`tool_invocations` row written for every run.
