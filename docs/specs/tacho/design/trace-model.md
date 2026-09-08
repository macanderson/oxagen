<!-- Re-homed from macanderson/cgp-website docs/design/tacho/trace-model.md (PR #27, 2026-08-31). The Oxagen spec at ../spec.md supersedes this file where they disagree. -->

# Tacho trace model

- Status: draft design
- Date: 2026-08-31
- Parent: [overview.md](overview.md)
- Decision record: [ADR 0005](adr-0005-tacho-trace-anchoring-and-cgp-export.md)

Tacho's trace format is standalone — OpenTelemetry-compatible on the way out,
CGP-exportable on the way up — rather than an extension of either. CGP is a
context *retrieval* protocol; Tacho records the *action* side and then serves
that history back as retrieval frames (§5).

## 1. Event envelope

Version string `tacho/1.0`. One event per observed action or lifecycle moment.

```jsonc
{
  "v": "tacho/1.0",
  "event_id": "evt_01J6XR8M2NQ4VT9CY0F3ZK7W5D",   // ULID
  "agent": {
    "agent_id": "agnt_…",
    "fleet_id": "flt_…",
    "runtime": "stella | vercel-ai | openai-agents | langchain | claude-agent | proxy",
    "wrapper_version": "1.4.2",
    "attestation": "sha256:…"        // wrapper build hash, signed into genesis
  },
  "session_id": "sess_01J6XR8KJ0…",  // ULID; one agent run
  "seq": 41,                          // dense per-session counter, starts at 0
  "ts": "2026-08-31T12:00:00.000Z",
  "kind": "tool_call",                // see §1.1
  "fidelity": "sdk | ambient | proxy",
  "span": {                           // OpenTelemetry identity, shared with OTLP export
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "span_id": "00f067aa0ba902b7",
    "parent_span_id": "…"
  },
  "body": { /* kind-specific, §1.2 */ },
  "content": {
    "digest": "sha256:…",             // digest of the raw payload
    "bytes_ref": "blob://…",          // optional pointer to retained raw bytes
    "redactions": [
      { "path": "body.args.email", "reason": "pii.email",
        "original_digest": "sha256:…" }
    ]
  },
  "prev_hash": "sha256:…",
  "hash": "sha256:…"                  // §2
}
```

### 1.1 Event kinds

| Kind | Emitted when |
| --- | --- |
| `agent_start` | Session opens. Genesis event: binds agent identity, wrapper attestation, session ephemeral public key. |
| `agent_stop` | Session closes (normal or abnormal; `body.outcome`). |
| `llm_call` | A model request completes (or fails). |
| `tool_call` | A tool/function invocation completes (or fails). |
| `file_io` | File read/write/delete observed (SDK-surfaced or ambient). |
| `network` | Network egress observed (SDK-surfaced, ambient, or proxy). |
| `approval_request` | Wrapper found no standing grant and asked the PDP. |
| `approval_decision` | PDP (or human) decided: allow / deny / escalate. |
| `token_issued` | Mint issued a capability token. |
| `token_use` | Wrapper verified a token and executed the action. |
| `token_denied` | Verification failed or PDP denied; action not executed. |
| `error` | Unhandled agent error, rollback, or wrapper-detected violation. |
| `telemetry_gap` | Events were dropped (backpressure, collector outage). Carries dropped-count estimate and duration. |
| `checkpoint` | Collector-signed chain commitment (§2). |

### 1.2 Kind-specific bodies (representative)

- `llm_call`: `{ model, provider, request_digest, response_digest,
  input_tokens, output_tokens, latency_ms, stop_reason }`
- `tool_call`: `{ tool, verb, resource, args_digest, result_digest,
  latency_ms, status, token_id? }` — `token_id` present when the call ran
  under a minted token.
- `network`: `{ direction, host, port, protocol, bytes_out, bytes_in,
  corroborated: bool }` — `corroborated` set by reconciliation against the
  egress proxy when it runs alongside the SDK.
- `approval_request`: `{ scope, resource, reason_text, requesting_span }`
- `approval_decision`: `{ request_event, outcome, policy_id?, approver_id?,
  reason_code, reason_text }`
- `token_issued`: `{ token_id, decision_event, scope, expires_at, use_limit }`

## 2. Hash chain, checkpoints, anchoring

Per-session tamper evidence, then global anchoring:

1. **Chain rule.** `hash = sha256(canon(event ∖ hash))` where `canon` is
   RFC 8785 JCS canonical JSON (the same canonicalization CGP's conformance
   fixtures use). `prev_hash` links `seq n−1 → n`. The genesis event
   (`agent_start`, `seq 0`, `prev_hash = sha256 of empty string`) binds
   `agent_id`, `session_id`, the wrapper build attestation, and the session's
   ephemeral public key — so the whole chain is rooted in *who* was recording.
2. **Checkpoints.** Every N events or T seconds (default 1 000 / 60 s) the
   collector emits a `checkpoint` event containing the current chain head,
   signed with its per-host device key. The control plane countersigns on
   ingest; a checkpoint without both signatures is invalid.
3. **Anchoring.** Checkpoint hashes are leaves in a public Merkle log; the
   root is published daily (and on demand for attestation reports). Rewriting
   history therefore requires forging the device key *and* the control-plane
   key *and* the already-published root — dashcam-grade evidence.
4. **Gaps are chained.** A `telemetry_gap` event occupies a `seq` slot like
   any other, so dropped data is visible and bounded, never silent.

## 3. Redaction and PII

Redaction must not break the chain and must remain auditable:

- Detection and redaction run in the **collector** (configurable detectors),
  never on the agent's hot path.
- The chained event hashes the **redacted** record, but each redaction entry
  retains `original_digest` — the sha256 of the raw field value. The chain
  stays valid, the redaction is visible, and an auditor with lawful access to
  retained raw bytes can still verify them against the digest.
- Insurer-facing artifacts never require raw bytes (digests and aggregates
  only — see [insurer-api.md](insurer-api.md)); raw retention is an
  enterprise-local policy choice.

## 4. OpenTelemetry mapping

Tacho ships an OTLP exporter from day one so the dashcam drops into existing
Datadog/Grafana/Honeycomb pipelines with zero ceremony.

| Tacho | OpenTelemetry |
| --- | --- |
| session | trace (root span `agent_start`→`agent_stop`) |
| event with duration (`llm_call`, `tool_call`) | span |
| instantaneous event (`approval_decision`, `token_use`, `telemetry_gap`) | span event on the enclosing span |
| `span.trace_id` / `span_id` / `parent_span_id` | native OTel identity (shared, not mapped) |
| `llm_call.body` | GenAI semantic conventions: `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` |
| Tacho-specific fields (`kind`, `fidelity`, `hash`, `token_id`, …) | attributes under `oxagen.tacho.*` |

The OTel view is a *convenience projection*; the hash-chained NDJSON stream is
the evidentiary record. Only the latter is chain-verifiable.

## 5. CGP export mapping

The CGP Export Provider is a standard CGP provider (revision
`contextgraph/1.0-draft`, NDJSON envelopes, handshake/query/frames/verify) that
serves Tacho history as frames. This keeps the strategic tie-in without
stretching CGP into an action protocol: an agent can ask, through the same
protocol it uses for code context, *"have I done this before, and was it
approved?"*

### Frame mapping

| Tacho record | CGP frame | Field mapping |
| --- | --- | --- |
| Session | `episode` | `frame_id = tacho:sess_<ulid>`; `content` = structured session summary; `content_digest` = sha256 of that summary; `canonical_content_hash` = final chain hash of the session; `valid_from`/`valid_to` = session start/stop; `recorded_at` = ingest time. |
| Distilled behavior ("denied scope X twice in 30 days") | `memory` | Produced by the scoring service; bi-temporal validity spans the observation window. |
| Notable single event (an approval, an incident) | `fact` | `valid_from` = event `ts`; digest = event `hash`. |
| Traceability chain (token → decision → request → span) | `graph` | Relations only; see below. |

### Relations

Published CGP rels plus a namespaced `tacho.*` vocabulary (CGP hosts must not
reject unknown rels, so this is conformant by construction):

- `episode.follows` — consecutive sessions of the same agent.
- `tacho.caused` — requesting span → approval episode.
- `tacho.approved_by` — session episode → approval-decision fact.
- `tacho.used_token` — action fact → token-issued fact.

### Consent

The provider declares
`DataFlow { reads: true, writes: false, egress: false, egress_scopes: ["local-only"] }`
by default — an agent's operational history never leaves the enterprise
boundary through CGP unless the deployment explicitly widens the scope.

### Verify

`verify`/`verified` works out of the box: every exported frame carries a real
digest, and session frames additionally carry the chain hash as
`canonical_content_hash`, so a host's default-deny retained/dropped partition
behaves correctly when history is re-queried after the fact.
