# Stella sidecar service — the external-engine transport (ADR-033 Option B)

**Status:** proposed. **Date:** 2026-07-20. **Owner:** Mac Anderson.
**Parent:** ADR-033 + `docs/specs/agent-engine-v2/spec.md` (this is a transport
companion, not a replacement). **Stella side:**
`macanderson/stella:docs/design/serve-surface.md`.

---

## Why this document exists

ADR-033 **chose Option A** (embed Stella via napi-rs, `stella-engine-node`) and
kept **Option B** (a Rust sidecar service over JSONL `AgentEvent` + reverse
tool-call RPC) as the documented fallback — *"identical port surface, transport
swappable."* We are now electing **Option B** as the near-term path: run the
Stella Rust binary as a **service** that the platform drives "under the hood,"
with real infra provisioned to host it.

The two options share **all** of Stella's port-mapping (spec.md §4.1) and **all**
of the durable-runner work (spec.md §4.2, Track 1). They differ only in the
transport between `executeTurn` and the engine: **in-process FFI (A)** vs.
**HTTP/SSE + reverse RPC (B)**. This doc specifies B and nothing else; when A
later lands, it swaps in at the same seam without touching any surface.

### Why B first

- **Serverless fit / ops honesty.** The engine turn future is `!Send` and
  stateful; it does not fit a Vercel function. A sidecar is a normal long-lived
  container — the same operational shape as the Modal sandbox runner we already
  run (`ops/modal-sandbox`).
- **No native-build gate.** Option A needs prebuilt napi binaries for
  linux-x64/arm64 + darwin, produced while org GitHub Actions is billing-locked.
  A container image is built from the Stella repo's own CI (or locally) and
  deployed as an image — no napi toolchain in this monorepo.
- **Cleaner sovereignty boundary.** The engine runs in its own process/container
  inside the tenant sandbox; every tool/model call crosses back over the wire to
  `kernel.invoke()`. Containment is a network + process boundary, not a shared
  address space.

The cost B pays — a network hop per tool/model callback — is the ADR's stated
downside. We accept it for now; the ports keep A available when latency demands.

## What plugs in where (unchanged from ADR-033)

The seam is **`executeTurn` / `executePipelineTurn`** in `@oxagen/agent-runner`
(`packages/agent-runner/src/execute-turn.ts`). Its module doc already says Phase
3 swaps the engine behind an `ENGINE` flag **there**. Option B is that swap, with
the engine reached over HTTP instead of FFI:

```
surfaces → executeTurn(surface, spec)
             │
             ├── ENGINE unset / "ts"     → runCodingAgent / runTurn   (today, unchanged)
             └── ENGINE = "stella"        → createStellaEngineClient().runTurn(spec)
                                             │ HTTP/SSE to STELLA_ENGINE_URL
                                             ▼
                    stella-serve sidecar (macanderson/stella)
                      run_step loop, emits AgentEvent over SSE,
                      remotes every tool/model/approval back here:
                      POST /v1/sessions/:id/tool-result → kernel.invoke() result
```

**No new user-facing capability, no new contract, no parity obligation.** The
Stella client is *internal plumbing behind the existing surfaces* — chat, REST,
A2A, `agent.repo.edit` already funnel through `executeTurn`. `check:manifest` /
`check:ui-parity` are unaffected because no contract gains a surface. (If a future
"which engine ran this turn" control becomes user-facing, that is a separate
contract; it is out of scope here.)

## New package: `@oxagen/stella-engine-client`

A thin client + the ports adapter. Location: `packages/stella-engine-client`.

- **`createStellaEngineClient(config)`** — `{ baseUrl, token, fetchImpl? }` from
  `STELLA_ENGINE_URL` / `STELLA_ENGINE_TOKEN` (mirrors `createModalSandbox` in
  `packages/sandbox/src/modal.ts`, the driver template).
- **`runTurn(spec)`** — creates a session, opens the events SSE, and services the
  reverse RPC. For every `tool_start` AgentEvent it receives, it calls the SAME
  materialized tool executor the TS engine uses (so **every tool call re-enters
  `kernel.invoke()`** — IAM → billing → entitlement → approval), then POSTs the
  `ToolResult` back by `call_id`. For every model request it calls
  `@oxagen/ai::streamAgentReply` (metering/billing/gateway intact) and streams
  deltas back. For every `scope_review` it creates an approval row via
  `createApprovalRequest` + `waitForApproval` and POSTs the decision back.
- **Event projection** — the incoming `AgentEvent` stream is the canonical run
  record. It is appended to the `agent_events` log (Phase 2 durable runner) and
  projected to the browser via the existing `translate-stream` → `use-tool-stream`
  path (spec.md §3 — this becomes "a thin projection" once typed `AgentEvent`
  lands via the Stella-side codegen).
- **Metering parity** — `streamAgentReply` writes the `token_usage` ClickHouse
  rows automatically (it is the Provider port). The client additionally emits the
  sandbox/compute cost event for `CommandRunner` executions (the gap spec.md §7
  names) so both model and compute cost are priced.

The port implementations are exactly the ones spec.md §4.1 lists — this doc only
changes their *transport* (HTTP callbacks instead of napi callbacks). The adapter
code is shared with Option A behind an interface.

## Configuration (new env vars)

Added to `packages/config/src/registry.ts` (`ENV_REGISTRY`) — the single source
of truth; `.env.example` is regenerated via `pnpm env:check --write`, never
hand-edited. Group them under a new `# ── Agent engine ──` block next to the
`Sandbox` block.

| Var | Group | Secret | Services | Default | Purpose |
|---|---|---|---|---|---|
| `ENGINE` | Agent engine | no | api, app, mcp | `ts` (dev/preview/prod) | Turn engine selector at the `executeTurn` seam: `ts` \| `stella`. |
| `STELLA_ENGINE_ENABLED` | Agent engine | no | api, app, mcp | `false` | Hard off-switch; `runTurn` falls back to `ts` if the client is unavailable. |
| `STELLA_ENGINE_URL` | Agent engine | no | api, app, mcp | (manual) | Base URL of the `stella-serve` sidecar. |
| `STELLA_ENGINE_TOKEN` | Agent engine | **yes** | api, app, mcp | (manual) | Bearer token for the sidecar (mint like `MODAL_RUNNER_TOKEN`: `openssl rand -hex 32`). |

`ENGINE=stella` requires `STELLA_ENGINE_ENABLED=true` + a resolvable
`STELLA_ENGINE_URL`+`STELLA_ENGINE_TOKEN`, exactly as `SANDBOX_DRIVER=modal`
requires `MODAL_RUNNER_URL`+`MODAL_RUNNER_TOKEN` (`packages/sandbox/src/index.ts:68`).
An availability guard (`isStellaEngineAvailable()`, mirroring `isSandboxAvailable()`)
is the single chokepoint; when it returns false, `executeTurn` uses the TS engine
so a mis-set flag degrades gracefully rather than 500ing.

## Infra provisioned

### Local dev — `docker-compose.dev.yml`

Add a `stella-engine` service alongside postgres/neo4j/clickhouse, behind a
compose **profile** so it only starts when opted in (the sidecar image builds
from the Stella repo; not every `pnpm dev` needs it):

```yaml
  stella-engine:
    profiles: ["stella"]              # `docker compose --profile stella up`
    image: ghcr.io/macanderson/stella-serve:${STELLA_ENGINE_TAG:-latest}
    container_name: oxagen-v2-stella-engine
    restart: unless-stopped
    environment:
      STELLA_SERVE_BIND: "0.0.0.0:8080"
      STELLA_SERVE_TOKEN: ${STELLA_ENGINE_TOKEN:-dev-stella-token}
      STELLA_SERVE_TOOLS: "remote"    # no local shell/web surface; delegate to host
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD", "/usr/local/bin/stella-serve", "healthcheck"]  # or wget /healthz
      interval: 10s
      timeout: 5s
      retries: 10
```

Wire `pnpm dev`'s launcher (`tools/scripts/dev.ts`) to set
`STELLA_ENGINE_URL=http://localhost:8080` + `ENGINE=stella` **only** when the
`stella` profile is active, so the default dev stack is unchanged.

### Production — container, not Vercel

The sidecar is a stateful long-lived process; it deploys as a **container**, not a
Vercel function. Two supported targets, both consuming the same
`macanderson/stella:packaging/docker/Dockerfile.serve` image:

1. **Modal (near-term, matches the sandbox precedent).** Deploy the image as a
   Modal web app behind a bearer token (the `ops/modal-sandbox` operational
   model). New `ops/stella-engine/` holds the deploy config + runbook mirroring
   `ops/modal-sandbox/README.md`. The engine runs **inside the tenant sandbox
   boundary** — it is co-located with, or invoked through, the same Firecracker
   isolation `agent.code.execute` uses, so its `CommandRunner` port runs commands
   in the tenant sandbox, never with ambient authority.
2. **Self-hosted container pool (when scale justifies).** The same image on a
   small always-on pool (ECS/Fly/Cloud Run). This is the "long-lived worker pool"
   ADR-033 §consequences already calls for — Option B fills it with the sidecar
   image instead of a napi-hosting Node worker.

Terraform: the engine needs no new AWS resources (AWS is tfstate + KMS only). The
BYOK provider keys the engine uses are decrypted by the platform's existing KMS
(`infra/modules/kms`) and passed to the sidecar per-session over the wire — the
engine never holds long-lived tenant secrets at rest.

### Deployment runbook (`ops/stella-engine/README.md`)

Mirrors `ops/modal-sandbox/README.md`: mint the shared token
(`openssl rand -hex 32`), build/push the image from the Stella repo, wire
`STELLA_ENGINE_URL`/`STELLA_ENGINE_TOKEN`/`STELLA_ENGINE_ENABLED`/`ENGINE` on
Vercel + `.env.local`, health-check `/healthz`, and the drift-diagnosis steps
(compare `/v1/meta` version against the deployed image tag).

## Sovereignty & containment (the rule that must not weaken)

- **Every tool call re-enters `kernel.invoke()`** on the platform side via the
  reverse RPC — IAM/billing/entitlement/approval stay exactly where they are. A
  bus `Deny` on the Stella side is defense-in-depth *above* the kernel gates,
  never a replacement.
- The sidecar runs with **`STELLA_SERVE_TOOLS=remote`**: it registers **no** local
  shell/web/process tools. The Stella tools sweep found `build_project`,
  `run_tests`, `verify_done`, and `run_script` shell out via `bash -c` even when
  `tools.bash` is off — remote mode omits them entirely; all execution is the
  host's governed sandbox exec.
- The sidecar is **one process per trust boundary**, token-gated, bound to a
  private network inside the sandbox. No multi-tenant sharing in one process
  (the sweep found process-global creds/config).
- Headless scope-review over blast-radius threshold with no host decision =
  the sidecar's `ScopeReviewRequiredHeadless` error → a real HITL approval row.
  **Never a silent auto-approve** (Stella semantics preserved).

## Rollout

1. **Off by default.** `ENGINE=ts` everywhere; the Stella client ships inert.
2. **Shadow mode.** Run `ENGINE=stella` in a preview env, compare AgentEvent
   streams + verdicts against the TS engine over the arena/SWE-bench suite
   (spec.md §7 parity gate). The Stella-side `validate_stream` conformance gate
   runs in CI over recorded platform streams.
3. **Per-surface flip.** Enable `stella` for `agent.repo.edit` / fleet code-mode
   first (they already get the judged pipeline), then chat/REST, gated on parity.
4. **Retire.** After parity, the TS `pipeline/index.ts` + loop heuristics retire
   (spec.md §5) — but only after B (or A) is proven.

## Build decomposition

See `stella-sidecar.fleet.toml` (this directory). Every task passes `pnpm gate`
(lint `--max-warnings 0` + typecheck + coverage + tests) and respects the
capability/tenancy/four-store rules before its commit lands. The Stella-side
build is its own plan (`macanderson/stella:docs/design/serve-surface.fleet.toml`)
and must land the `stella-serve` image before this plan's integration task can
run end-to-end.
