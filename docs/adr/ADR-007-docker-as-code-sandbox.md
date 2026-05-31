# ADR-007 — Docker as vendor-neutral code sandbox

**Date:** 2026-05-28
**Status:** Accepted (see also [ADR-011](./ADR-011-vercel-sandbox-driver.md) which adds a Vercel-native driver)
**Epic:** Agent Runtime

## Context

`agent.code.execute` needs a sandboxed environment to run user-supplied
Node, Python, or shell code. Requirements: isolation per invocation,
CPU/memory caps, network gating, multi-language, vendor-neutral so we
can move it anywhere.

## Decision

Use **Docker** with short-lived containers per invocation, pinned
images, and a strict `HostConfig` policy. The driver lives behind a
`SandboxDriver` interface in `packages/sandbox` so a future managed
provider is a one-file swap.

## Alternatives considered

- **E2B (`@e2b/code-interpreter`).** Managed, fast cold starts, Python
  + Node. Vendor lock-in; data crosses E2B's plane.
- **Cloudflare Workers (Workers for Platforms).** Per-tenant subworker
  pattern with WfP dispatch namespaces. Vendor lock-in to Cloudflare;
  Pyodide ceiling breaks `numpy`/`pandas`/most ML libs; paid tier
  required.
- **`isolated-vm` (V8 isolates in Node).** Fast, in-process, JS-only.
  Doesn't cover Python or shell.
- **Firecracker microVMs (self-hosted).** Strongest isolation, but
  significantly more ops surface than Docker. Reach for it later if
  Docker's caps bite.

## Consequences

- Pinned images in `packages/sandbox/src/images.ts`:
  `node:20-alpine`, `python:3.12-slim`, `alpine:3.20`.
- Per-container flags: `--network=none|bridge`, `--read-only`
  rootfs, tmpfs at `/work` and `/tmp`, `Memory=512MiB`,
  `NanoCpus=500_000_000` (0.5 CPU), `PidsLimit=128`,
  `User=65534:65534`, `CapDrop=ALL`,
  `SecurityOpt=no-new-privileges`, `AutoRemove=true`.
- Code delivered via `putArchive` to the writable tmpfs.
- Wallclock timeout enforced by the runner (default 30s).
- Tradeoff: requires Docker on the runner host. Acceptable locally and
  on most cloud runners; native rootless Docker covers everything we
  need.
- Tradeoff: cold-start budget ~50ms Linux, ~300ms macOS. Acceptable;
  pool warmup amortizes.
