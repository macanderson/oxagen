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

## Cost guardrails

A run at the default limits (Python 3.12, 512 MB, 5 s) costs ~$0.0003 of
Modal credits. The $30 free tier covers ~100k runs/month before any spend.
Per-tenant billing is metered by `@oxagen/billing` from the
`tool_invocations` row written for every run.
