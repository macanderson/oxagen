# ADR-011 — Vercel Sandbox driver for Vercel Functions

**Date:** 2026-05-31
**Status:** Accepted
**Epic:** Agent Runtime

## Context

`agent.code.execute` uses the `SandboxDriver` interface in `packages/sandbox`
to isolate and run user-supplied code. ADR-007 established Docker as the
primary driver; Modal was added later as a hosted Firecracker alternative.

Two deployment constraints have emerged:

1. **Docker is unavailable on Vercel Functions.** Vercel's serverless runtime
   does not expose a Docker daemon, so `SANDBOX_DRIVER=docker` cannot be used
   in production deploys to Vercel.
2. **Modal requires a separately-deployed Python runner.** The Modal driver
   (`src/modal.ts`) calls a self-hosted HTTP shim (`ops/modal/runner.py`).
   This extra operational surface is undesirable before we have dedicated ops
   infrastructure.

Vercel released `@vercel/sandbox` (v2.0.2, 2026-05-29), a first-party SDK
that provisions short-lived Firecracker microVMs directly from Node code
without any additional deployment. On Vercel Functions, auth is resolved
automatically via OIDC (`VERCEL_OIDC_TOKEN` injected by the runtime),
requiring zero credential configuration at deploy time.

## Decision

Add a third `SandboxDriver` implementation in `packages/sandbox/src/vercel.ts`
backed by `@vercel/sandbox` 2.0.2 (pinned exactly). Select it at runtime when
`SANDBOX_DRIVER=vercel`. All three drivers (docker, modal, vercel) remain
fully functional; selection is a deploy-time env-var choice.

Changes:
- `packages/sandbox/package.json` — add `"@vercel/sandbox": "2.0.2"` to
  `dependencies`.
- `packages/sandbox/src/vercel.ts` — new `createVercelSandbox()` factory
  implementing `SandboxDriver`.
- `packages/sandbox/src/index.ts` — add `vercel` branch to `getSandbox()`;
  the vercel driver is checked **before** modal so `SANDBOX_DRIVER=vercel`
  always wins.
- `packages/config/src/env.ts` — extend `SANDBOX_DRIVER` enum to include
  `"vercel"`; add `VERCEL_SANDBOX_TOKEN`, `VERCEL_SANDBOX_TEAM_ID`,
  `VERCEL_SANDBOX_PROJECT_ID` as optional vars (OIDC auto-resolves on
  Vercel Functions).
- `docs/adr/ADR-007-docker-as-code-sandbox.md` — note added referencing
  ADR-011.
- `docs/architecture/env/README.md` — updated with the three new vars and
  the vercel driver row.

## Alternatives considered

- **Keep Modal only.** Rejected: requires deploying and maintaining a
  separate Python runner. Pre-scale ops burden with no clear benefit over
  the Vercel-native option.
- **E2B (`@e2b/code-interpreter`).** Rejected per ADR-007: data crosses
  E2B's data plane; vendor lock-in.
- **`isolated-vm` / inline Node VM.** Rejected: JavaScript-only; does not
  cover Python or shell.
- **Cloudflare Workers for Platforms.** Rejected per ADR-007: Pyodide ceiling
  breaks most ML libraries; requires Cloudflare vendor lock-in.
- **Self-hosted Firecracker microVMs.** Deferred per ADR-007: significant
  ops surface. Reach for it if Vercel sandbox costs bite at scale.

## Consequences

- **Runtimes:** `@vercel/sandbox` supports `node24` and `python3.13`. Shell
  scripts run on `node24` via `/bin/sh`. The `shell` language is mapped to
  the `node24` runtime with the entrypoint `/bin/sh /tmp/main.sh`.
- **OOM detection:** `@vercel/sandbox` does not expose an OOM-killed flag.
  `SandboxResult.oomKilled` is hardcoded to `false` for this driver.
  Downstream billing/metrics code must tolerate `false` from the vercel driver.
- **stdin not supported:** `runCommand` does not accept a stdin pipe. The
  driver throws `VercelSandboxUnsupportedError` when `req.stdin` is non-empty.
  Callers should embed input in the code file directly.
- **Auth in local dev:** Without `VERCEL_OIDC_TOKEN` or explicit credentials,
  `Sandbox.create()` will throw an auth error. Set `VERCEL_SANDBOX_TOKEN`,
  `VERCEL_SANDBOX_TEAM_ID`, and `VERCEL_SANDBOX_PROJECT_ID` for local dev
  when `SANDBOX_DRIVER=vercel`.
- **Network cost:** Unlike the docker driver (local), every `run()` call makes
  outbound HTTPS calls to Vercel's API. Tests must never set
  `SANDBOX_DRIVER=vercel` without mocking the SDK.
- **Version pin:** `@vercel/sandbox` is pinned to exactly `2.0.2`. The SDK
  was published 2 days before this ADR; monitor the changelog for breaking
  changes before upgrading.

## ADR-007 relationship

ADR-007 remains **Accepted**. This ADR adds the Vercel driver as an additional
option, not a replacement. Docker remains the default for local development
and self-hosted deploys. See ADR-007 for the interface design rationale and
the full set of Docker-specific consequences.
