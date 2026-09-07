<!-- Re-homed from macanderson/cgp-website docs/design/tacho/overview.md (PR #27, 2026-08-31). The Oxagen spec at ../spec.md supersedes this file where they disagree. -->

# Tacho — the tachograph for AI agents

- Status: draft design
- Date: 2026-08-31
- Owner: Oxagen
- Companion documents: [trace-model.md](trace-model.md),
  [approval-tokens.md](approval-tokens.md), [trust-scoring.md](trust-scoring.md),
  [insurer-api.md](insurer-api.md), [threat-model.md](threat-model.md)
- Decision records: [ADR 0003](adr-0003-tacho-capability-tokens-biscuit.md)
  (token format), [ADR 0004](adr-0004-tacho-policy-engine-cedar.md)
  (policy engine), [ADR 0005](adr-0005-tacho-trace-anchoring-and-cgp-export.md)
  (trace anchoring and CGP export)

## 1. Naming and positioning

**Tacho**, from *tachograph* — the tamper-evident recorder mandated in
commercial trucks, whose sealed logs are admissible evidence and set insurance
premiums. "Dashcam for AI agents" is the elevator pitch; *tachograph* is the
honest product: not just a recording of what happened, but a sealed,
regulator-and-insurer-grade record plus an enforced duty cycle.

> **The tachograph for AI agents — record everything, authorize anything,
> insure the fleet.**

Three lines of positioning:

1. **Dashcam.** One-line wrap. Every LLM call, tool call, file access, and
   network egress recorded, hash-chained, tamper-evident.
2. **Permission authority.** An agent that wants to exceed its standing grants
   asks Tacho. Approval is the minting of a scoped, expiring capability token,
   traceable to the exact triggering event and the reasons it was granted.
3. **Telematics for underwriters.** Verifiable operational history → trust
   scores → premium discounts. The permission-authority role is the moat: an
   enterprise can rip out a logger, but not the thing that signs its agents'
   elevation tokens.

Package names: `@oxagen/tacho` (TypeScript/npm), `tacho` (Python/PyPI),
`tacho-core` (Rust crate, native inside Stella).

## 2. Design requirements

Derived from the product brief; every subsequent choice traces to one of these.

- **R1 — SDK-agnostic.** Works with Stella, Vercel AI SDK, OpenAI Agents SDK,
  Claude Agent SDK, LangChain, and bespoke loops, in any language.
- **R2 — Dead simple.** Integration is one line where the agent is created;
  everything the agent does flows through the wrapper.
- **R3 — No performance drag.** Telemetry never blocks the agent's hot path.
- **R4 — Granular, tamper-evident traces.** Every action is a record suitable
  as evidence, comparable to what Stella/CGP track for context.
- **R5 — Permission authority.** Out-of-grant actions require an approval that
  mints an expiring token with full traceability to the triggering event and
  the reasons for issuance.
- **R6 — Trust over time.** Each agent carries a trustability score that grows
  with clean operation and drops on incidents, gating auto-approval.
- **R7 — Insurable.** The record is verifiable by a third party (underwriter)
  without trusting Oxagen or the enterprise, and without exposing raw traces.

## 3. Architecture

Four tiers, strictly layered. Nothing in a lower tier trusts anything above it.

```
┌────────────────────────────────────────────────────────────────────┐
│ AGENT PROCESS                                                      │
│   Wrapper SDK (in-proc)                                            │
│     intercept → emit events (lock-free ring buffer, async drain)   │
│     enforce   → verify capability tokens offline (Ed25519 pubkey)  │
└───────────────┬────────────────────────────────────────────────────┘
                │ UDS/gRPC — batched fire-and-forget (telemetry)
                │            synchronous (elevation only)
┌───────────────▼────────────────────────────────────────────────────┐
│ LOCAL COLLECTOR (per-host daemon or sidecar)                       │
│   WAL buffer · per-session hash chain · signed checkpoints         │
│   cached policy bundle + mint pubkeys (offline verify)             │
│   optional egress proxy (independent corroboration)                │
└───────────────┬────────────────────────────────────────────────────┘
                │ mTLS
┌───────────────▼────────────────────────────────────────────────────┐
│ CONTROL PLANE                                                      │
│   Ingest + Trace Store  append-only log, Merkle-anchored           │
│   PDP (Cedar)           policy eval + agent history + HIL queue    │
│   Mint                  Biscuit tokens · root pubkeys · CRL        │
│   Trust Scoring         streaming per-agent/fleet scores           │
│   CGP Export Provider   traces as episode/memory/fact frames       │
└───────────────┬────────────────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────────────┐
│ CONSUMERS                                                          │
│   Fleet dashboard (enterprise) · Attestation API (insurers)        │
│   CGP hosts (agents querying their own operational history)        │
└────────────────────────────────────────────────────────────────────┘
```

### Data flow

1. Agent performs an action → wrapper interceptor sees it.
2. **Telemetry path (always):** event goes onto a bounded lock-free ring
   buffer → collector WAL → hash-chained into the session chain →
   batch-uploaded to the trace store. *Fail-open:* the agent never blocks on
   telemetry; a full buffer drops oldest and records a chained
   `telemetry_gap` marker, so the gap itself is evidence.
3. **Enforcement path (out-of-grant actions only):** wrapper finds no standing
   grant → emits `approval_request` → synchronously asks the PDP (via the
   collector) → PDP evaluates Cedar policy + trust-score tier + optionally a
   human approver → Mint issues a Biscuit bound to the agent, session, exact
   action scope, expiry, and the approval event id → wrapper verifies the
   token offline, emits `token_use`, executes. *Fail-closed:* no verified
   token, no action.
4. The scoring service consumes the event stream and updates trust scores;
   the attestation API serves signed aggregates plus Merkle inclusion proofs;
   the CGP export provider serves the same history as retrieval frames.

### Performance stance (R3)

Interception adds exactly two costs to the agent process:

- a content hash plus an enqueue onto a bounded lock-free queue
  (drop-oldest under backpressure, never block);
- on enforcement paths only, one in-process Ed25519 signature verification
  (~50 µs) against cached mint public keys.

The network is never on the hot path except for elevation, which is by
definition a slow path (something unusual is being asked for).

## 4. Wrapper integration contract (R1, R2)

Three integration styles share one internal event API; `tacho-core` semantics
are identical across languages.

### (a) Object wrap — the default, one line

```python
agent = tacho.wrap(agent)
```

Returns a proxy: a TypeScript `Proxy`, Python `__getattr__` delegation, and in
Rust a `TachoAgent<A: Agent>` newtype (native in Stella). Adapters recognize
the SDK by registry/duck-typing:

| SDK | Interception mechanism |
| --- | --- |
| Vercel AI SDK | `wrapLanguageModel` middleware + `experimental_telemetry` |
| OpenAI Agents SDK | `RunHooks` / trace processors |
| LangChain | callbacks handler |
| Claude Agent SDK | hook matchers (`PreToolUse` / `PostToolUse`) |
| Stella | native `tacho-core` crate, first-class |
| Unknown/bespoke | generic proxy over the object's public surface |

Opt-in, the wrapper also patches the process's HTTP client and file APIs to
catch access the SDK never surfaces; such events carry `origin: "ambient"`.

### (b) Middleware / hooks

Where an SDK exposes lifecycle hooks, `tacho.middleware()` / `tacho.hooks()`
returns the SDK-native object. Style (a) composes these internally — the
one-liner is sugar over (b), never a separate code path.

### (c) Sidecar / egress-proxy fallback

For closed agents (binaries, SaaS runtimes): run the collector as a forward
proxy, optionally with eBPF/`LD_PRELOAD` file monitoring. Events are coarser
(`network`, `file_io` only) and every one is flagged `fidelity: "proxy"`; the
trust-scoring service weighs proxy-only fleets lower. In high-assurance
deployments the same proxy runs *alongside* style (a) as independent
corroboration of the SDK's self-reported egress (see
[trust-scoring.md](trust-scoring.md), anti-gaming).

### Failure semantics (normative, stated in every SDK's docs)

- **Telemetry is fail-open.** Buffer full, collector down, network dead — the
  agent proceeds; a `telemetry_gap` marker is chained so the absence of data
  is itself visible, chain-verifiable evidence.
- **Enforcement is fail-closed.** A token that cannot be verified is a deny.
  PDP unreachable — standing grants still work (evaluated locally against the
  cached policy bundle); elevation requests queue or fail.

## 5. Rollout phasing

- **Phase 1 — Dashcam (observe-only MVP).** Wrapper SDKs (TypeScript, Python,
  Stella-native), collector, hash-chained trace store, OTLP export, basic
  dashboard. No enforcement — zero-risk adoption; drops into existing
  Datadog/Grafana pipelines via OpenTelemetry.
- **Phase 2 — Authority.** Cedar PDP, Biscuit mint, human-in-loop queue,
  standing-grant bundles, fail-closed enforcement, CGP export provider.
  Stickiness begins here.
- **Phase 3 — Telematics.** Trust scoring GA, tiered auto-approval,
  attestation API, first underwriter design partner.

## 6. Glossary

| Term | Meaning |
| --- | --- |
| Wrapper | The in-process SDK that intercepts and enforces. |
| Collector | Per-host daemon: buffers, chains, signs, forwards. |
| Session | One agent run; the unit of hash-chaining. |
| Standing grant | A pre-authorized action class, in the signed Cedar bundle. |
| Elevation | A request to act outside standing grants. |
| PDP | Policy decision point — the Cedar policy service. |
| Mint | The service that issues Biscuit capability tokens. |
| Checkpoint | A signed, countersigned chain commitment, Merkle-anchored. |
| Attestation report | Signed fleet aggregates + proofs for underwriters. |
| Fidelity | How directly an event was observed: `sdk`, `ambient`, `proxy`. |
