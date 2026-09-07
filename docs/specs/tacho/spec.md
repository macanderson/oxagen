# Tacho — Oxagen as the control plane for Claude Code, Claude Agent SDK agents, and custom agents

**Status:** Proposed

**Decision date:** 2026-09-06

**Owner:** platform (governance plane)

**First surface:** a developer workstation enrolled with one command, after which every Claude Code session on that machine is observed, policy-gated, and evidenced by Oxagen

**Related:** `docs/adr/ADR-040-governance-plane-refocus.md` (the mandate; this spec is its Phase 2 "wrapper"), `docs/specs/governance-plane-refocus/review.md` §2(a) (the two enforcement tiers), `docs/specs/run-evidence-ingress/spec.md` (Approved; `client_attested` authority is reserved for exactly this), `docs/adr/ADR-024-namespaced-agent-identity.md` (`agentKey`), `docs/adr/ADR-035-consume-context-graph-protocol-directly.md` / `ADR-036` (CGP consumption), `design/` (the Tacho product design re-homed from `cgp-website`, with its three decision records `design/adr-0003..0005`), Stella `docs/spec/oxagen-trace-drain.md` and `docs/spec/serve-surface.md` (the Stella-side seams this contract must also fit), `context-graph-protocol` `contextgraph-trace` (the host-trace journal and its eight replay oracles)

---

## 1. Executive decision

**One package, `@oxagen/tacho`, is the Oxagen wrapper for every agent Oxagen does not run itself.** It carries three adapters over one core, and one per-host daemon:

| Surface | How it attaches | Enrollment unit |
|---|---|---|
| **Claude Code** (interactive and `-p`) | Claude Code hooks (`SessionStart` … `SessionEnd`) plus Claude Code's native OpenTelemetry export, both pointed at a local collector | the **host**: `oxagen tacho enroll` once per machine, then every Claude Code session on it is governed |
| **Claude Agent SDK** agents | the same hook handlers, passed in-process through `options.hooks` | the **agent**: registered under an `agentKey`, credentialed with a scoped API key |
| **Custom agents** (Vercel AI SDK, OpenAI Agents SDK, LangChain, bespoke loops) | `tacho.wrap(agent)` / `wrapTool` / `wrapModel` / `authorize` proxies | the **agent**, as above |

The design formerly called Tacho ("the tachograph for AI agents", `design/overview.md`) is not a sibling product to this wrapper; **it is this wrapper.** Its tamper-evident trace model, approval tokens, trust scoring, and threat model are adopted here as-is where this spec does not narrow them. Where the two disagree, this spec wins and says so in §12.

Two commitments shape everything below:

1. **Claude Code is controlled through the same contract Stella will implement natively.** Stella today has no live Oxagen control loop either (it has a content-free telemetry export, a usage drain, a headless engine, and a driver channel; see Stella `docs/spec/oxagen-trace-drain.md` §1). This spec therefore defines the **control contract** (§7), the **evidence contract** (§6), and the **enrollment contract** (§5) once, in Oxagen. Claude Code meets it through hooks; Stella meets it through `tacho-core` linked into its executor (`design/examples/rust-stella.md`). "Controlled like a Stella agent" is thereby a statement about the contract, not about parity with a Stella feature that does not yet exist.
2. **The claim is honest about the two tiers.** Per ADR-040 §4 and the review §2(a): a hook that denies a tool call inside a process Oxagen does not own is **attestation with harness-level enforcement**, graded `client_attested`. Only tool calls that route through Oxagen's governed gateway (the workspace MCP endpoint, or a reverse-RPC engine such as `stella-serve`) are **gateway-enforced**. Every session record carries its `enforcement_tier` and every event its `fidelity`; nothing in the UI, docs, or attestation reports may say "prevented" where the record says "observed".

Codex CLI is out of scope for v1 (§13). Its hook surface is documented upstream but was not verified in this design pass, and the user's instruction was to focus on Claude Code if Codex would need a materially different approach.

---

## 2. Requirements

Tacho's seven product requirements (`design/overview.md` §2: R1 SDK-agnostic, R2 one-line, R3 no hot-path drag, R4 tamper-evident traces, R5 permission authority, R6 trust over time, R7 insurable) stand. This spec adds the harness requirements that the product brief did not have to state:

- **H1 — One command per machine.** `oxagen tacho enroll` (or `npx @oxagen/tacho enroll` on a machine without the CLI) enrolls the host. From that moment every Claude Code session started by that OS user, in any directory, in any mode (`claude`, `claude -p`, `--resume`, subagents, worktrees, `claude --settings`), is observed and gated. Nothing else needs to be installed, cloned, or edited, and no repository needs a `.claude/settings.json` change.
- **H2 — Parity of controls with the Oxagen kernel.** Every control Oxagen has for its own agents has a defined effect on an enrolled Claude Code session: IAM role grants and denies, `iam.emergency_denies` and the deny-generation counter, approval requests, budget ceilings, and the audit chain. Where a control cannot be made to bite (a hard process kill), the spec says "best effort" and the record says so too.
- **H3 — One contract, three producers.** The event envelope, policy bundle, elevation exchange, and evidence finalization are the same for the Claude Code adapter, the Claude Agent SDK adapter, the custom-agent SDK, and Stella's native `tacho-core`. A session from any producer lands in the same tables and compares in the same UI.
- **H4 — Two projections, one record.** The hash-chained `tacho/1.0` stream is the evidentiary record. The OpenTelemetry view (`design/trace-model.md` §4) and the CGP host-trace journal (§6.4) are derived projections. A projection is never the source of truth and is never chain-verified on its own.
- **H5 — Fail-open telemetry, fail-closed enforcement.** Verbatim from the design and restated because Claude Code's own hook semantics would otherwise invert it: a failed telemetry hook must never block a session; a failed **enforcement** hook must never let an out-of-grant action proceed. §5.4 shows how the two are separated at the hook level.
- **H6 — Tamper-evident, and honest about tamper-proof.** An engineer can edit `~/.claude/settings.json`, set `disableAllHooks`, or run an unenrolled Claude Code binary. The design's answer holds: this is visible evidence (an `unobserved_session` or `hooks_removed` incident, a chain gap), it lowers the trust score, and an enterprise that needs prevention deploys the managed-settings lockdown (§5.5). The spec never claims the hooks cannot be removed.
- **H7 — Zero coupling in the published artifact.** `@oxagen/tacho` is one of three public npm packages (with `@oxagen/cli` and `@oxagen/skills`). It ships with no `@oxagen/*` runtime dependency, following the CLI's standalone-publish discipline (`apps/cli/scripts/prepare-standalone-publish.mjs`) and the usage-telemetry pattern of carrying its own copy of a schema with a test-only cross-check against the server package.

Non-goals for v1: an egress proxy or eBPF ambient capture (`design/overview.md` §4(c)), the insurer attestation API (`design/insurer-api.md`), and a Codex adapter. The event model reserves room for all three.

---

## 3. Architecture

The four tiers of `design/overview.md` §3 hold. This section places each tier in the Oxagen monorepo and names the Claude Code specifics.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ AGENT PROCESS                                                               │
│  Claude Code           Claude Agent SDK agent        Custom agent           │
│   hooks (command+http)  options.hooks (in-proc)      tacho.wrap()/wrapTool  │
│   OTel logs → OTLP      env OTEL_* for subprocess    wrapModel middleware    │
│        │  tacho-hook (enforcement; fail-closed against cached bundle)       │
└────────┼────────────────────────────┬──────────────────────┬────────────────┘
         │ UDS / loopback HTTP        │ UDS or inline        │ UDS or inline
┌────────▼────────────────────────────▼──────────────────────▼────────────────┐
│ tachod — per-host collector (packages/tacho/src/collector)                  │
│  hook receiver · OTLP/HTTP receiver · WAL (SQLite) · per-session hash chain │
│  cached policy bundle + mint pubkeys · local standing-grant evaluation      │
│  spool → batched ingest (at-least-once, lease, bisection) · inbox drain     │
│  unobserved-session detector (ps + transcript mtime) · trace/OTLP export    │
└────────┬────────────────────────────────────────────────────────────────────┘
         │ HTTPS, host API key (scope purpose `tacho_host`) or agent API key
┌────────▼────────────────────────────────────────────────────────────────────┐
│ OXAGEN CONTROL PLANE (apps/api → packages/oxagen contracts → handlers)      │
│  create_tacho_host_enrollment · ingest_tacho_events · get_tacho_policy_bundle│
│  request_tacho_elevation · control_tacho_session · resolve_approval (exists)│
│  PDP = kernel IAM (authorizeExternalCapability) → Cedar when needed (§12)   │
│  Mint = Biscuit tokens (design/adr-0003) · deny generations · emergency deny│
│  stores: Postgres agent.tacho_hosts / tacho_sessions / approval_requests    │
│          ClickHouse tacho_events (+ tool_invocations, token_usage, audit)   │
│          evidence: RunEvidenceManifestV1 via ingest_run_evidence (phase C)  │
│  projections: OTLP export · CGP export provider · contextgraph-trace journal│
└────────┬────────────────────────────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────────────────────────┐
│ CONSUMERS  fleet page (hosts, sessions, flight recorder) · /approvals queue  │
│            audit export · CGP hosts querying their own history               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Data flow, Claude Code

1. Claude Code fires a hook. Enforcement events reach `tacho-hook`, a small executable shipped in the package; telemetry-only events reach `tachod` directly over loopback HTTP. Claude Code's OpenTelemetry exporter posts model-call events to `tachod`'s OTLP receiver on the same loopback port.
2. `tachod` normalizes each hook or OTLP record into a `tacho/1.0` event (§6.1), assigns the next dense `seq` for the session, chains it, and appends it to the WAL before answering the hook. The answer to a telemetry hook is always "continue"; the answer to an enforcement hook is the policy decision (§7.2).
3. A spool loop ships WAL batches to `ingest_tacho_events` with the host API key. Every ingest response carries the host's current `deny_generation`, bundle `etag`, and any pending control commands for the sessions in the batch (§7.4), so an active host needs no separate control poll.
4. On the control plane the handler derives tenant identity from the API key (never the body), validates the batch, writes ClickHouse `tacho_events`, upserts `agent.tacho_sessions`, and records every policy decision it made in `iam.authorization_decisions`.
5. At `SessionEnd` (or when `tachod` observes the process gone), the session is sealed: final chain hash, outcome, completeness gaps. In phase C the seal produces a `RunEvidenceEnvelopeV1` and the platform finalizes a `client_attested` manifest through `ingest_run_evidence`.

### 3.2 Performance stance

Unchanged from the design (R3): a telemetry hook costs one HTTP POST to loopback, answered after a local WAL append (target p50 under 5 ms, measured in the plan). An enforcement hook costs one process spawn of `tacho-hook` plus one local bundle evaluation; the network is on the path only for elevation. The plan carries a budget of 30 ms p95 for `tacho-hook` start-to-decision on a warm host; if a Node-based executable cannot meet it, the enforcement binary moves to a compiled target before GA, and the hook contract does not change.

---

## 4. Package home and public surface

### 4.1 Where it lives

`packages/tacho/` in this monorepo, published as **`@oxagen/tacho`**. It is a leaf package: no `@oxagen/*` runtime dependency (H7). Subpath exports:

| Export | Contents |
|---|---|
| `@oxagen/tacho` | core: `tacho/1.0` zod schema, JCS digest and chain, `startSession`, `emit`, `authorize`, `wrapTool`, `wrapModel`, `wrap`, transport client, inline emitter |
| `@oxagen/tacho/claude-agent-sdk` | `govern(options, identity)` merging `hooks` and `env` into `ClaudeAgentOptions`; `wrapQuery(query)` |
| `@oxagen/tacho/claude-code` | the hook handler (`handleHookEvent(input) → output`, shared by `tacho-hook` and the SDK adapter), the settings writer, the enrollment routine, the OTel env block |
| `@oxagen/tacho/collector` | `tachod`: receivers, WAL, chain, spool, inbox, detector, exporters |
| `@oxagen/tacho/trace` | projection to `contextgraph-trace` NDJSON and the TypeScript port of its eight oracles (§6.4) |
| bins | `tacho` (enroll, status, unenroll, daemon, export, verify), `tacho-hook`, `tachod` |

The `oxagen` CLI (`apps/cli`) gains `oxagen tacho <enroll|status|unenroll|export|verify>` as thin delegates to the same functions, so a machine that already has the CLI uses it and a machine that does not runs `npx @oxagen/tacho enroll`. Both paths are the same code and the same enrollment contract.

Server-side code lives where every other capability lives: contracts in `packages/oxagen/src/contracts/tacho.*.ts`, handlers in `packages/handlers/src/tacho.*.ts`, routes in `apps/api/src/routes/v1/tacho.*.ts`, ClickHouse migrations in `packages/telemetry/src/migrations/`, Drizzle schema in `packages/database/src/schema/agent.ts`. A shared-schema package is not introduced; the published wrapper carries its own copy of the wire schema and a test asserts byte parity with the contract's zod-to-JSON-Schema output, exactly as `apps/cli/src/telemetry/usage.ts` does for usage telemetry.

### 4.2 Why one package and not three

The design's R1 and R2 are only true if the Claude Code hook handler, the Claude Agent SDK hook callback, and the custom-agent `wrapTool` gate are the same function with three entry points. A second package per harness is the "per-framework connector sprawl" the governance review names as the risk to resist. The adapters are subpath exports precisely so that a Codex adapter, when it comes, is one more subpath and not one more product.

---

## 5. Enrollment — the one command

### 5.1 `oxagen tacho enroll`

```
oxagen tacho enroll [--org <slug>] [--workspace <slug>] [--token <api key>] [--managed] [--print-managed]
```

Steps, each idempotent, each printed as it runs:

1. **Authenticate** using the CLI's existing flow (`apps/cli/src/commands/auth.ts`: browser PKCE on a TTY, `--token` headless). Validate with `GET /v1/auth/whoami`. Pick org and workspace with the existing pickers.
2. **Generate the host device key** (Ed25519) into `~/.config/oxagen/tacho/device.key` (0600, `write_sensitive_file_atomic` semantics as in Stella's `identity.rs`). The public key travels in the enrollment; the private key never leaves the host. It signs collector checkpoints (`design/trace-model.md` §2).
3. **Call `create_tacho_host_enrollment`** (§5.2). The response carries the host enrollment id (`thst_…`), a host-scoped API key shown once, the signed enrollment claims, the initial policy bundle, and the mint public keys. The routine writes them to `~/.config/oxagen/tacho/host.json` (0600).
4. **Install `tachod`** as a user service: a launchd agent on macOS (`~/Library/LaunchAgents/sh.oxagen.tachod.plist`), a systemd user unit on Linux (`~/.config/systemd/user/tachod.service`). It listens on a Unix socket and on `127.0.0.1:<port>`; the port is chosen at enrollment and pinned in `host.json`. A per-install local bearer token is minted for the loopback listener so another local user cannot post fake events.
5. **Write the Claude Code hooks** into the **user** settings file `~/.claude/settings.json` (§5.4). The writer merges: it adds its own hook entries tagged with a `"_tacho": "<enrollment id>"` marker, never removes a hook it did not write, never touches `permissions`, and is a no-op when the entries already exist. It also writes the `env` block that turns on Claude Code's OpenTelemetry export toward the collector.
6. **Verify** by asking `tachod` for its health and by checking that `claude` resolves on `PATH` and its version is within the tested range. `--verify` additionally runs `claude -p --max-turns 1` with a fixed prompt and confirms a `session_start` and `session_end` pair arrived at the control plane.

`oxagen tacho status` prints enrollment identity, daemon health, hook presence per event, bundle version and age, last successful ingest, spool depth, and the count of unobserved sessions since enrollment. `oxagen tacho unenroll` reverses step 5, stops the service, and calls the revoke endpoint; the host key is deleted and the enrollment marked revoked server-side.

### 5.2 `create_tacho_host_enrollment`

Modeled on `create_stella_enrollment` (`packages/oxagen/src/contracts/telemetry.stella.enroll.ts`) because its shape already answers the hard questions: an operator-only, session-authenticated, org-scoped capability that mints a purpose-locked API key and returns a signed claims document.

```ts
input: z.object({
  hostname: z.string().min(1).max(253),
  osUser: z.string().min(1).max(128),
  platform: z.enum(["darwin", "linux", "win32"]),
  devicePublicKey: z.string().regex(/^ed25519:[A-Za-z0-9+/=]{40,}$/),
  harnesses: z.array(z.enum(["claude-code"])).min(1),   // "codex" reserved
  validityDays: z.number().int().min(1).max(365).default(180),
}).strict(),
output: z.object({
  hostEnrollmentId: z.string().regex(/^thst_[0-9a-f]{20}$/),
  agentKey: z.string(),                 // ADR-024 key of the host's agent record, e.g. acme.core.cc-macbook-mac
  apiKeyPublicId: z.string(),
  apiKey: z.string(),                   // shown once; scope purpose "tacho_host"
  enrollment: z.object({ claims: z.record(z.unknown()), signature_hex: z.string() }),
  policyBundle: policyBundleSchema,     // §7.1
  mintPublicKeys: z.array(z.object({ keyId: z.string(), publicKey: z.string(), notAfter: z.string() })),
  expiresAt: z.string(),
}).strict()
```

Server behaviour: role gate (org Owner/Admin by default; a workspace role may be granted the capability for self-enrollment), creation of one `agent.agents` row per host with `agent_type: "claude-code"` and an `iam.principals` row of kind `agent` whose `parent_user_id` is the enrolling human, insertion of the API key with `scope: { purpose: "tacho_host", host_enrollment_id }` and the reserved-purpose refusal in `create_api_key` extended to it, and HMAC signing of the claims with the length-framed canonical scheme in `packages/handlers/src/lib/stella-enrollment-signing.ts` under a new domain string `oxagen.tacho.host-enrollment-signature.v1`. The signature lets the managed-settings document (§5.5) be verified offline by `tacho-hook` without a network call.

Identity consequence: a Claude Code host is an **agent** in the registry with an `agentKey`, which is the identifier a bill, an audit row, and an approval card show. Each Claude Code session is a session of that agent; the human at the keyboard is the `initiating_principal` and the host agent is the `agent_principal`, the same intersection the run-evidence spec requires.

### 5.3 Claude Agent SDK and custom agents

These do not enroll a host. They register an agent (`agent.definition.create` with `agent_type: "claude-agent-sdk"` or `"custom"`), receive an agent-scoped API key, and pass `{ agentKey, apiKey }` to `startSession` or `govern`. The collector is optional for them: if `tachod` is reachable the SDK uses it (shared chain, shared spool); otherwise the inline emitter chains and spools in-process to `~/.config/oxagen/tacho/spool/<agentKey>/` and ships directly. The trade is stated in the docs: an inline emitter cannot sign checkpoints with a host device key, so its checkpoints carry the agent key's fingerprint and its sessions score against the wider posterior (`design/trust-scoring.md` §3).

### 5.4 The hook set the enrollment writes

The split follows H5. **Enforcement events run a `command` hook** (`tacho-hook`) because Claude Code treats a failed `http` hook as a non-blocking error and lets the action proceed, which is fail-open. `tacho-hook` speaks to `tachod` over the Unix socket; if the daemon is down it evaluates the cached bundle itself and appends to the spool file, so enforcement never depends on the daemon being up. **Telemetry-only events run an `http` hook** straight into `tachod`, with no process spawn.

| Claude Code event | Hook type | Decision the hook can return | Tacho events produced (§6.2) |
|---|---|---|---|
| `SessionStart` (`startup`, `resume`, `clear`, `compact`, `fork`) | command | `additionalContext` (governed context injection, §7.5); deny only when the host is `suspended` | `agent_start` (genesis, or a linked resume/fork) |
| `UserPromptSubmit` | command | deny with reason when the session or host is `paused`/`suspended`; `additionalContext` | `turn_start` |
| `PreToolUse` | command | `permissionDecision` allow / deny / ask, `updatedInput` (attenuation, e.g. rewrite an egress URL) | `policy_decision`, then `tool_requested` on allow, `token_denied` on deny |
| `PermissionRequest` | command | `decision.behavior` allow / deny; blocks up to the hook timeout while an elevation is pending | `approval_request`, `approval_decision`, `token_issued` or `token_denied` |
| `Stop` | command | never blocks in v1 (no `decision: block`) | `turn_end` |
| `PostToolUse`, `PostToolUseFailure` | http | none | `tool_call` (+ `file_io` / `network` / `command` side effects) |
| `SubagentStart`, `SubagentStop` | http | none | `subagent_start`, `subagent_stop` (child session linkage) |
| `PreCompact`, `PostCompact` | http | none | `oxagen:compaction` |
| `PermissionDenied`, `Notification` | http | none | `policy_decision` (harness-originated), informational |
| `ConfigChange` | http | none (v1 records; v2 may block edits to hook entries) | `oxagen:config_change`, incident `hooks_removed` when the marker entries disappear |
| `SessionEnd` | http | none | `agent_stop` |

Model calls have no hook. They come from Claude Code's OpenTelemetry log exporter: the enrollment writes into the settings `env` block `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>`, and `OTEL_LOG_TOOL_DETAILS=1`. `tachod` accepts `/v1/logs` and `/v1/metrics`, and turns each `api_request` record into an `llm_call` event (model, tokens by tier, cost, duration, `prompt.id`). Prompt and response bodies are **not** enabled (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_RAW_API_BODIES` stay unset); digests come from the hook payloads and the transcript, never from raw bodies in flight.

Hook payload handling is digest-first: `tool_input` and `tool_response` are hashed and size-counted at the collector; raw retention is a per-workspace policy (`retention_policy_versions.mode`), off by default, and when on the bytes go through the collector's redaction detectors before the encrypted blob path of the run-evidence spec. `prompt` from `UserPromptSubmit` is digested only.

### 5.5 Managed (enterprise) enrollment

`--managed` (or `--print-managed` for MDM tooling) writes the same hooks and env block into Claude Code's managed settings file (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux) together with `allowManagedHooksOnly: true`, `disableBypassPermissionsMode: true`, and the signed enrollment document. In this mode a user cannot remove the hooks from user or project settings, cannot run `--dangerously-skip-permissions`, and `tacho-hook` verifies the enrollment signature offline at every start. This is the design's "enterprise gateway" posture; the record still labels it `client_attested`, because the process remains one Oxagen does not run.

---

## 6. The evidence contract

### 6.1 Envelope

The `tacho/1.0` envelope of `design/trace-model.md` §1 is adopted verbatim: `v`, `event_id` (ULID), `agent { agent_id, fleet_id, runtime, wrapper_version, attestation }`, `session_id`, dense `seq` from 0, `ts` (the CGP timestamp profile: uppercase `T`, uppercase `Z`, UTC only), `kind`, `fidelity`, `span`, `body`, `content { digest, bytes_ref?, redactions[] }`, `prev_hash`, `hash`. Two narrowings:

- `agent.agent_id` is the ADR-024 `agentKey`; `agent.fleet_id` is the workspace public id. `runtime` gains the values `claude-code` and `claude-agent-sdk`.
- `session_id` is the harness session id where the harness has one (Claude Code's UUID); the control plane derives `session_uuid = uuidv5(NS_TACHO_SESSION, "<hostEnrollmentId>/<session_id>")` and `event_id_idem = "evt_" + sha256(session_uuid, seq)`, so re-sends after a lost ack land in the same ClickHouse row. Derivation happens in the collector, following the reasoning in Stella's drain analysis §4: the client must be able to re-send and land in the same place.

Chain rule, checkpoints, gaps as chained events, and digest-preserving redaction are as designed (§2, §3 of the trace model). Checkpoints are signed by the host device key and countersigned on ingest. Merkle anchoring of checkpoint hashes is phase D.

### 6.2 Event kinds

The design's fourteen kinds stand. This spec adds, additively, the kinds a harness adapter needs that a wrapped SDK object did not:

| Kind | Emitted when | Why it is new |
|---|---|---|
| `turn_start`, `turn_end` | a user prompt is submitted; the assistant stops | the CGP journal is turn-scoped and the design had no turn boundary |
| `tool_requested` | after `PreToolUse` allows, before execution | pairs with `tool_call` to give the CGP `tool_call` / `tool_result` pair and to catch a call that never resolved (crash) |
| `policy_decision` | every standing-grant evaluation, including harness-originated denies | a deny is evidence even when no elevation was attempted |
| `subagent_start`, `subagent_stop` | Claude Code spawns / finishes a subagent | subagents are child sessions with their own chain, linked by `body.parent_session_id` and the spawning `tool_use_id` |
| `oxagen:compaction`, `oxagen:config_change`, `oxagen:unobserved_session`, `oxagen:hooks_removed` | harness lifecycle and tamper signals | vendor-namespaced per CGP U3 |

`body` shapes for the harness kinds are fixed in the package's zod schema and its published JSON Schema; the representative bodies in the design (`llm_call`, `tool_call`, `network`, `approval_*`, `token_*`) are unchanged.

### 6.3 Fidelity and enforcement tier

`fidelity` keeps its three values. A Claude Code hook event is `sdk` fidelity: hooks are the harness's own first-class surface and cover every tool call. The session record additionally carries:

- `enforcement_tier`: `gateway` when every tool in the session routed through the Oxagen MCP endpoint or a reverse-RPC engine; `harness` when Tacho gated tools via hooks; `observe` when the bundle was in observe-only mode.
- `completeness.gaps[]` in the run-evidence vocabulary: `model_calls` (OTel exporter absent or unreachable), `tool_bodies` (retention off), `hooks_partial` (a hook entry missing for part of the session), `unobserved_tail` (process ended without `SessionEnd`).

These fields are what the review's honesty rule is enforced by: the fleet UI and attestation reports read them and cannot render a stronger word than the tier allows.

### 6.4 Projections

1. **OpenTelemetry** as designed (`design/trace-model.md` §4): `tachod` and the control plane can export OTLP with GenAI semantic conventions and `oxagen.tacho.*` attributes.
2. **CGP export provider** as designed (§5): sessions as `episode` frames, incidents as `fact` frames, distilled behaviour as `memory`, chains as `graph` relations, `DataFlow.egress_scopes: ["local-only"]` by default.
3. **CGP host-trace journal.** `contextgraph-trace` (`TRACE_FORMAT = "contextgraph-trace/0.1-sketch"`) is the closest thing CGP has to agent conformance: an NDJSON journal graded by eight replay oracles. CGP does not define a "conformant agent" (SPEC §12 binds providers and hosts), so the claim this spec makes is exact: **every Tacho session exports a journal that passes all eight oracles, and the package ships the oracle port and pinned upstream fixtures that prove it.** The mapping:

| Tacho | `contextgraph-trace` |
|---|---|
| `agent_start` | `session_start { agent: agentKey, harness: "claude-code/<version>", model, trace_format }`; a resumed session emits `resume { last_seq_seen }` |
| `agent_stop` | `session_end { outcome: completed \| aborted }`; a session with an `unobserved_tail` gap emits nothing, which the oracles read as a crash, correctly |
| `turn_start` / `turn_end` | `turn_start` / `turn_end` with the envelope `turn` set on every event between |
| `llm_call` | `prompt_assembled { budget_tokens: context window, declared_total_tokens, frames: [] }` then `model_response { tool_calls: [tool_use_id…] }`; the tool ids are the `tool_requested` events observed under the same `prompt.id` |
| `tool_requested` | `tool_call { call_id: tool_use_id, tool }` |
| `tool_call` | `tool_result { call_id, status: ok \| error }` |
| `policy_decision` deny, `token_denied` | `tool_result { status: rejected }` with no preceding `tool_call`, which is the spec's own denial model |
| `file_io`, `network`, `command` | `side_effect { effect_id, kind, call_id }`; `effect_id = sha256(session, tool_use_id, path-or-url)` so a crash-replayed effect is the same id twice by construction |
| verify observations | `verify_observed` only when frames came from a CGP provider through the Oxagen MCP endpoint; otherwise absent, and `staleness-at-use` / `citation-at-use` / `deterministic-composition` report `skipped`, never `pass` |

The `assembly-budget-honesty` oracle is honest for Claude Code only in the degenerate sense (no frames declared, so no arithmetic to drift). The export marks `frames_source: "none" | "oxagen-mcp"` in the journal's `session_start.agent` suffix so a reader knows which oracles had teeth. The package pins `contextgraph-trace/fixtures/` (golden, golden-resume, one `trip-*` per oracle) byte-for-byte with an upstream-commit manifest and a drift gate, the ADR-035 pattern applied to the trace crate.

### 6.5 Storage

Following the three-plane split Oxagen already uses and Stella's drain analysis §5:

- **ClickHouse** `tacho_events`: `ReplacingMergeTree(received_at) ORDER BY (org_id, workspace_id, event_id_idem)`, columns for the envelope scalars, `body` as JSON string, `content_digest`, `prev_hash`, `hash`, `fidelity`, `received_at`. Tool events are additionally projected into the existing `tool_invocations` with `surface: "tacho"` and `external_provider: "claude-code"`; `llm_call` events into `token_usage`. Retention follows the existing TTLs.
- **Postgres** `agent.tacho_hosts` (enrollment: agent id, principal id, device public key, platform, status `active|paused|suspended|revoked`, bundle version served, last seen), `agent.tacho_sessions` (session uuid, host or agent, harness, started/ended, outcome, enforcement tier, final chain hash, checkpoint count, gaps, parent session). Approvals reuse `agent.approval_requests`; every gate decision the control plane makes reuses `iam.authorization_decisions`.
- **Evidence** (phase C): each sealed session produces a `RunEvidenceEnvelopeV1` and the platform finalizes a `RunEvidenceManifestV1` with `evidence_authority: client_attested` and a replay grade computed from the gaps. `ingest_run_evidence` does not exist in TypeScript yet (the Postgres foundation does); this wrapper is its first consumer. Raw bodies, when retained, go to tenant-encrypted blobs and never to ClickHouse or Neo4j.
- **Neo4j**: the CGP export provider's `episode`/`fact` frames and `tacho.*` relations, projected from finalized sessions only.

---

## 7. The control contract (Oxagen → agent)

CGP deliberately specifies no downward channel (its governance text says fleet policy "belongs to whatever product operates a fleet, and Oxagen is one such product"). This channel is therefore Oxagen's, namespaced `oxagen:` where it touches CGP vocabulary, and is the same for every producer (H3).

### 7.1 Policy bundle

`get_tacho_policy_bundle` returns a signed document, cached by the collector, evaluated locally for standing grants:

```ts
{
  version: number,            // monotonic per workspace
  etag: string,
  issued_at: string, expires_at: string,
  host_status: "active" | "paused" | "suspended",
  deny_generation: { org: number, workspace: number },   // iam.authorization_deny_generations
  permissions: { allow: string[], deny: string[], ask: string[] },  // Claude Code rule syntax, compiled from IAM
  tools: Record<string, { risk_grade: "low"|"medium"|"high"|"critical", read_only: boolean, capability_id?: string }>,
  budget: { session_limit_usd?: number, daily_limit_usd?: number, mode: "observed" | "enforced" },
  context: { system: string | null },   // governed injection text, §7.5
  retention: { mode: "digest_only" | "content_exact", classes: string[] },
  mode: "observe" | "enforce",
  signature: { key_id: string, alg: "ed25519", sig: string }
}
```

The bundle is **compiled from Oxagen IAM**, not authored separately: role grants and denies for the host agent's principal become `permissions` rules in Claude Code's own syntax (`Bash(git push*)`, `Write(src/**)`, `mcp__github__*`), tool risk grades come from `tool_declarations` and the contract registry, budget from `workspace_budget_policy`. The kernel's `authorizeExternalCapability()` is the policy decision point for anything the bundle does not settle (§7.2). Cedar (design ADR 0004) is retained as the decided engine for the day a policy cannot be expressed as an IAM ceiling plus a rule list; §12 records the sequencing.

Precedence at the host is the CLI's four-scope model (`apps/cli/src/config/resolve.ts`): a managed enrollment is org-locked; user and project Claude Code settings may **narrow** but never widen what the bundle allows, mirroring Stella's authority rule ("lower-precedence input may narrow authority but never widen it").

### 7.2 Standing grants and the `PreToolUse` decision

For every `PreToolUse`, `tacho-hook` evaluates, in order: host and session status (paused or suspended → deny with the operator's reason); bundle freshness (a `deny_generation` newer than the cached bundle marks it stale; a stale bundle allows read-only tools and requires a synchronous re-evaluation for the rest, failing closed if the control plane is unreachable); explicit `deny` rules (always win); `allow` rules (allow); `ask` rules or no rule (the decision falls through to Claude Code's own permission flow, which surfaces as `PermissionRequest` and thereby to elevation). In `observe` mode the evaluation is recorded and the answer is always allow.

Tool calls to the Oxagen MCP endpoint (`mcp__oxagen__*`) are not evaluated here at all; the kernel evaluates them on the server, and those calls are what earn a session the `gateway` tier.

### 7.3 Elevation and tokens

`PermissionRequest` is the elevation point. `tacho-hook` emits `approval_request`, then calls `request_tacho_elevation` with the canonical action (`tool:<name>`, resource, digest of the input, the requesting span, the trust tier). The handler runs `authorizeExternalCapability("claude.<tool>", ctx, "require_approval")`; an `allow` mints a token; `require_approval` creates an `agent.approval_requests` row and the handler holds the request on the existing `waitForApproval` listener up to the hook timeout (default 600 s, configurable per bundle); a resolution through the existing `resolve_approval` capability (from the `/approvals` queue, Slack, or the CLI) returns `allow` or `deny`. The token is a Biscuit v2 as decided (design ADR 0003): bound to `agentKey`, session, exact action, expiry (default 120 s), use limit, and the approval event id, verified offline by `tacho-hook` against the cached mint keys, then `token_use` and `behavior: allow`. Deny or verification failure is `token_denied` and `behavior: deny`; the hook's `permissionDecisionReason` carries the policy id or approver so the model and the human see why.

While an elevation is pending, the collector shows it in `oxagen tacho status` and the control plane shows it in the approvals queue with the four-hop chain (`design/approval-tokens.md` §4).

### 7.4 Commands: pause, resume, cancel, message, revoke

`control_tacho_session` and `control_tacho_host` write a command row; the collector receives commands in the next ingest response or, when idle, from a long-poll on `GET /v1/tacho/inbox?after=<seq>`. Effects:

| Command | Effect on an enrolled Claude Code session | Guarantee |
|---|---|---|
| `pause` | next `UserPromptSubmit` and `PreToolUse` are denied with the reason; the current tool call completes | guaranteed at the next boundary |
| `resume` | clears the pause | guaranteed |
| `cancel` | every further prompt and tool call is denied; `tachod` sends `SIGTERM` to the `claude` process it has matched to the session (by transcript path and cwd) | soft cancel guaranteed; process termination best effort and recorded as `oxagen:kill_attempted` with the outcome |
| `message` | injected as `additionalContext` at the next `UserPromptSubmit` (or `SessionStart` for a resumed session) | delivered at the next boundary |
| `revoke` (host) | host status `suspended`; every session denied at its next boundary; API key revoked; `tacho-hook` reads `suspended` from the bundle and denies even if the daemon is down | guaranteed while the hooks are installed; visible as `hooks_removed` if not |
| deny-generation bump / emergency deny | the ingest response carries the new generation; the cached bundle is stale (§7.2) | guaranteed for non-read-only tools |

These are the same operations `stella-serve` exposes as `/pause`, `/resume`, `/cancel`, `/steer`; the names are aligned so the fleet UI has one verb set.

### 7.5 Governed context injection

The bundle's `context.system` is injected at `SessionStart` and after `compact` via `additionalContext`. It is authored on the control plane through the same closed operation set the lifecycle framework already uses (`prepend_system_context` / `append_system_context` only; nothing rewrites the harness's instructions), it is IAM-gated, and the injected text's digest is chained as part of `agent_start` so a replay shows exactly what the agent was told.

---

## 8. Claude Agent SDK adapter

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { govern } from "@oxagen/tacho/claude-agent-sdk";

for await (const msg of query({
  prompt,
  options: govern(options, { agentKey: "acme.core.billing-helper", apiKey: process.env.OXAGEN_AGENT_KEY }),
})) { … }
```

`govern` merges hook matchers for the same event set as §5.4 into `options.hooks`, using the same `handleHookEvent` function the CLI binary uses, so the decision logic cannot drift between the two adapters. It sets the OTel `env` block for the SDK's subprocess and registers the session with the collector or the inline emitter. The hook callbacks are synchronous for enforcement events and return `{ async: true }` for telemetry events, matching H5. `wrapQuery(query)` is sugar that applies `govern` to every call.

## 9. Custom agents

`@oxagen/tacho` is the SDK of `design/overview.md` §4: `startSession({ agentKey, apiKey })`, `wrap(agent)` (Proxy with SDK detection: Vercel AI `wrapLanguageModel` middleware, OpenAI Agents `RunHooks`, LangChain callbacks, generic proxy), `wrapTool(tool, session)` (standing-grant check, elevation, `token_use`, execute, `tool_call`), `wrapModel(model, session)` (`llm_call` with digests and usage), `authorize(action)` (explicit elevation), `emit(event)`, `end(outcome)`. The `design/examples/` sketches are the reference; the plan turns `wrap-vercel-ai.ts` into the first runnable example.

Custom agents are `client_attested` by construction. They reach the `gateway` tier only when their tools are Oxagen capabilities called through the workspace MCP endpoint or the metered inference endpoint, which the SDK makes the easy path (`tacho.tools.oxagen(session)` returns the governed toolset).

## 10. Stella

Stella implements this contract natively (`tacho-core`, `design/examples/rust-stella.md`): the executor's `tool.call.requested` bus event is the `PreToolUse` equivalent, `policy.evaluated` maps to `policy_decision`, its `ApprovalRequest`/`ApprovalResponse` types carry elevation, and `stella-serve`'s `/pause` `/resume` `/cancel` are the command set. Its existing signed-enrollment machinery (`enterprise_telemetry.rs`) is what §5.2 copies, so the Stella side of enrollment is a second event class on an existing document, not a new mechanism. A `stella-serve` session is `gateway` tier by construction and needs no hooks; a workstation Stella session is `client_attested` like Claude Code. The Stella-repo plan is a numbered sub-plan of this spec (plan §PR 9) and a Stella `docs/spec/` companion, following the `serve-surface.md` pattern.

## 11. Threat model deltas for a hooked harness

`design/threat-model.md` stands. Claude Code adds four concrete adversary moves and their answers:

| Move | Answer |
|---|---|
| Remove or edit the hook entries, set `disableAllHooks`, or run with `--settings` overriding them | `ConfigChange` hook records the edit while it still runs; `tachod` re-reads the settings file each bundle refresh and raises `hooks_removed`; the unobserved-session detector (below) catches the sessions that follow; managed mode (§5.5) prevents it |
| Run Claude Code with `CLAUDE_CONFIG_DIR` pointed elsewhere, or an unenrolled binary | the detector watches for `claude` processes and for transcript files under `~/.claude/projects/**` (and the configured alternate dir when known) whose mtime advances without a matching hook stream, and chains `oxagen:unobserved_session`; the host's trust score pays for it |
| Spoof events at the loopback listener | per-install local bearer token in the hook headers; the daemon also cross-checks `session_id` against a live transcript path before accepting a genesis event |
| Prompt-inject an elevation | `reason_text` is untrusted data at the PDP; decisions rest on policy, tier, and canonical action; approvers see the requesting span, not the model's claim |

Accepted limitation, stated as the design states it: a fully compromised host can lie to its own collector. The claim is tamper-evident completeness, priced into the score and disclosed in reports.

## 12. Decisions this spec makes that narrow the design

1. **Policy engine sequencing.** Phase B's decision point is the Oxagen kernel (`authorizeExternalCapability`) with bundles compiled from IAM into Claude Code rule syntax. Cedar (design ADR 0004) is adopted when a customer policy cannot be expressed that way; the bundle format reserves a `cedar_bundle` member so the switch is additive. The ADR's rationale is unchanged; only its arrival is later.
2. **Token format.** Biscuit v2 (design ADR 0003) from the first enforcing release; no interim JWT.
3. **Trace format.** The design's ADR 0005 keeps `tacho/1.0` standalone and exports to OTel and CGP frames. This spec adds a third export, the `contextgraph-trace` journal, and makes passing its oracles a release gate. The ADR's reasoning ("two projections must be kept in sync with the envelope") now covers three.
4. **Consent unit.** The host enrollment is the consent unit for Claude Code; the agent registration is the consent unit for SDK agents; retention of raw bodies is a further per-workspace grant. This answers Stella's drain analysis open question 2 for every producer.
5. **Fidelity vocabulary.** Hooks are `sdk` fidelity; no fourth value is added.
6. **Naming.** The product name is Tacho, the package is `@oxagen/tacho`, the daemon is `tachod`, the hook binary is `tacho-hook`. The `cgp-website` copies of the design are superseded by `design/` here and the site links to this folder (plan §PR 0).

## 13. Codex CLI

Out of scope for v1. The upstream documentation at `developers.openai.com/codex/hooks` describes a hook system with a `PreToolUse`-style pre-execution decision, which suggests the Claude Code adapter's shape would transfer, but the field names, configuration location, blocking semantics, and telemetry surface were not verified in this design pass. `@oxagen/tacho/codex` is reserved as a subpath; the plan carries a one-day spike whose output is either a mapping table like §5.4 or a note that Codex needs a proxy-fidelity adapter instead.

## 14. Acceptance criteria

1. On a clean macOS or Linux machine with Claude Code installed, `oxagen tacho enroll` (or `npx @oxagen/tacho enroll`) completes with one authentication and no further edits, and `oxagen tacho status` reports healthy.
2. After enrollment, an interactive `claude` session, a `claude -p` session, a `--resume` of each, a session in a new directory, and a subagent spawned inside one all produce chained sessions visible on the fleet page within 10 seconds of `SessionEnd`, each with a matching `agent_start`/`agent_stop`, dense `seq`, and verifiable chain.
3. Every tool call in those sessions appears as `tool_requested` + `tool_call` with input and output digests, latency, status, and a side-effect classification; every model call appears as `llm_call` with model, token tiers, and cost; the session total reconciles with Claude Code's own `total_cost_usd` for `-p` runs within rounding.
4. A tool matching a bundle `deny` rule is refused at `PreToolUse` with the rule named, and the refusal is a chained `policy_decision` and an `iam.authorization_decisions` row.
5. A tool with no standing grant produces an `approval_request` visible in the approvals queue; approving it there mints a Biscuit token, the tool runs once, and the four-hop chain (`token_use → token_issued → approval_decision → approval_request → span`) is navigable; denying it refuses the tool with the approver's reason shown to the model.
6. `pause`, `resume`, `message`, and `cancel` from the fleet page take effect at the next prompt or tool boundary and are chained with the operator's principal; `cancel` also records the kill attempt outcome.
7. An `iam.emergency_denies` row or deny-generation bump refuses every non-read-only tool on every enrolled host within one ingest interval, and fails closed when the control plane is unreachable.
8. Removing the hook entries from `~/.claude/settings.json` on an enrolled host produces a `hooks_removed` incident and, for the next session, an `unobserved_session` incident; in managed mode the removal is not possible from user or project settings.
9. Stopping `tachod` mid-session loses no enforcement (denies still apply from the cached bundle) and no telemetry (spooled by `tacho-hook`), and the resulting chain carries a `telemetry_gap` only for the `http`-hook events that could not be delivered.
10. Every session exports a `contextgraph-trace/0.1-sketch` journal that passes all eight oracles, with `skipped` reported for the frame oracles when no CGP frames were served; the pinned upstream fixtures pass and each `trip-*` fixture fails exactly its oracle in the TypeScript port.
11. Every session exports OTLP that renders as one trace per session in a stock OpenTelemetry collector with GenAI semantic conventions.
12. A Claude Agent SDK agent governed with `govern()` and a Vercel AI SDK agent wrapped with `wrap()` produce sessions that pass criteria 3 to 5 and 10 with `runtime` set accordingly.
13. The session record's `enforcement_tier` is `gateway` only when every tool call in it was served by the Oxagen MCP endpoint or a reverse-RPC engine; the fleet UI, exports, and reports never use the word "enforced" for a `harness` or `observe` session.
14. Sealed sessions finalize a `RunEvidenceManifestV1` with `evidence_authority: client_attested` and a replay grade derived from `completeness.gaps[]`; the manifest verifies offline with the published platform key.
15. Tenant identity is never taken from an ingest body: a batch whose events name another workspace is rejected, and the accepted rows carry the API key's scope.
16. `@oxagen/tacho` publishes with no `@oxagen/*` runtime dependency, and its wire schema is byte-identical to the contract's generated JSON Schema in a test.
17. A telemetry hook round-trip (`PostToolUse` to acknowledged WAL append) measures p50 under 5 ms and `tacho-hook` start-to-decision measures p95 under 30 ms on the reference laptop; the numbers are recorded in the plan's verification section.
18. `oxagen tacho unenroll` leaves `~/.claude/settings.json` with every non-Tacho entry intact, stops the service, and the host shows `revoked` on the fleet page.

## 15. Open questions a maintainer owns

1. Whether the host agent record should be one per host (this spec) or one per host × repository, which would give per-repo `agentKey`s at the cost of registry sprawl. Recommendation: one per host; the session carries `cwd` and the repository binding, and lineage projects per repo.
2. Whether `Stop` should ever block (Claude Code allows a hook to return `decision: block` to keep the agent working). Deferred; it is the "duty cycle" half of the tachograph metaphor and belongs with trust scoring.
3. Where the `/approvals` queue lands in navigation (review Phase 3). This spec depends on it existing; it does not decide its placement.
