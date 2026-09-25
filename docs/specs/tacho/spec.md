# Tacho — Oxagen as the control plane for Claude Code, Claude Agent SDK agents, and custom agents

**Status:** Proposed

**Decision date:** 2026-09-06

**Owner:** platform (governance plane)

**First surface:** a developer workstation enrolled with one command, after which every Claude Code session on that machine is observed, policy-gated, and evidenced by Oxagen

**Related:** `docs/adr/ADR-078-wrapped-and-connected-are-two-enforcement-tiers-neither-dominates.md` (the connected tier this spec's §5.6 implements, and the rule that neither tier dominates the other), `docs/adr/ADR-040-governance-plane-refocus.md` (the mandate; this spec is its Phase 2 "wrapper"), `docs/specs/governance-plane-refocus/review.md` §2(a) (the two enforcement tiers), `docs/specs/run-evidence-ingress/spec.md` (Approved; `client_attested` authority is reserved for this), `docs/adr/ADR-024-namespaced-agent-identity.md` (`agentKey`), `docs/adr/ADR-035-consume-context-graph-protocol-directly.md` / `ADR-036` (CGP consumption), `design/` (the Tacho product design re-homed from `cgp-website`, with its three decision records `design/adr-0003..0005`), Stella `docs/spec/oxagen-trace-drain.md` and `docs/spec/serve-surface.md` (the Stella-side seams this contract must also fit), `context-graph-protocol` `contextgraph-trace` (the host-trace journal and its eight replay oracles)

---

## 1. Executive decision

**One package, `@oxagen/tacho`, is the Oxagen wrapper for every agent Oxagen does not run itself.** It carries three adapters over one core, and one per-host daemon:

| Surface | How it attaches | Enrollment unit |
|---|---|---|
| **Claude Code** (interactive and `-p`) | Claude Code hooks (`SessionStart` … `SessionEnd`) plus Claude Code's native OpenTelemetry export, both pointed at a local collector | the **host**: `oxagen tacho enroll` once per machine, then every Claude Code session on it is governed |
| **Claude Agent SDK** agents | the same hook handlers, passed in-process through `options.hooks` | the **agent**: registered under an `agentKey`, credentialed with a scoped API key |
| **Custom agents** (Vercel AI SDK, OpenAI Agents SDK, LangChain, bespoke loops) | `tacho.wrap(agent)` / `wrapTool` / `wrapModel` / `authorize` proxies | the **agent**, as above |

The design formerly called Tacho ("the tachograph for AI agents", `design/overview.md`) **is this wrapper.** Its tamper-evident trace model, approval tokens, trust scoring, and threat model are adopted here as-is where this spec does not narrow them. Where the two disagree, this spec wins and says so in §12.

The spec makes two commitments:

1. **Claude Code is controlled through the same contract Stella will implement natively.** Stella today has no live Oxagen control loop either (it has a content-free telemetry export, a usage drain, a headless engine, and a driver channel; see Stella `docs/spec/oxagen-trace-drain.md` §1). This spec therefore defines the **control contract** (§7), the **evidence contract** (§6), and the **enrollment contract** (§5) once, in Oxagen. Claude Code meets it through hooks; Stella meets it through `tacho-core` linked into its executor (`oxagen-roadmap:docs/oxagen/specs/tacho/design/examples/rust-stella.md`). "Controlled like a Stella agent" means controlled through this contract; Stella has no live control loop yet.
2. **The record distinguishes the two enforcement tiers.** Per ADR-040 §4 and the review §2(a): a hook that denies a tool call inside a process Oxagen does not own is **attestation with harness-level enforcement**, graded `client_attested`. Only tool calls that route through Oxagen's governed gateway (the workspace MCP endpoint, or a reverse-RPC engine such as `stella-serve`) are **gateway-enforced**. Every session record carries its `enforcement_tier` and every event its `fidelity`; nothing in the UI, docs, or attestation reports may say "prevented" where the record says "observed".

Codex CLI is out of scope for v1 (§13). Its hook surface is documented upstream but was not verified in this design pass, and the user's instruction was to focus on Claude Code if Codex would need a materially different approach.

---

## 2. Requirements

Tacho's seven product requirements (`design/overview.md` §2: R1 SDK-agnostic, R2 one-line, R3 no hot-path drag, R4 tamper-evident traces, R5 permission authority, R6 trust over time, R7 insurable) stand. This spec adds the harness requirements that the product brief did not have to state:

- **H1 — One command per machine.** `oxagen tacho enroll` (or `npx @oxagen/tacho enroll` on a machine without the CLI) enrolls the host. From that moment every Claude Code session started by that OS user, in any directory, in any mode (`claude`, `claude -p`, `--resume`, subagents, worktrees, `claude --settings`), is observed and gated. Nothing else needs to be installed, cloned, or edited, and no repository needs a `.claude/settings.json` change.
- **H2 — Parity of controls with the Oxagen kernel.** Every control Oxagen has for its own agents has a defined effect on an enrolled Claude Code session: IAM role grants and denies, `iam.emergency_denies` and the deny-generation counter, approval requests, budget ceilings, and the audit chain. Where a control cannot be made to bite (a hard process kill), the spec says "best effort" and the record says so too.
- **H3 — One contract, three producers.** The event envelope, policy bundle, elevation exchange, and evidence finalization are the same for the Claude Code adapter, the Claude Agent SDK adapter, the custom-agent SDK, and Stella's native `tacho-core`. A session from any producer lands in the same tables and compares in the same UI.
- **H4 — Two projections, one record.** The hash-chained `tacho/1.0` stream is the evidentiary record. The OpenTelemetry view (`design/trace-model.md` §4) and the CGP host-trace journal (§6.4) are derived projections. A projection is never the source of truth and is never chain-verified on its own.
- **H5 — Fail-open telemetry, fail-closed enforcement.** Verbatim from the design and restated because Claude Code's own hook semantics would otherwise invert it: a failed telemetry hook must never block a session; a failed **enforcement** hook must never let an out-of-grant action proceed. §5.4 shows how the two are separated at the hook level.
- **H6 — Tamper-evident, not tamper-proof.** An engineer can edit `~/.claude/settings.json`, set `disableAllHooks`, or run an unenrolled Claude Code binary. As in the design, this is visible evidence (an `unobserved_session` or `hooks_removed` incident, a chain gap), it lowers the trust score, and an enterprise that needs prevention deploys the managed-settings lockdown (§5.5). The spec never claims the hooks cannot be removed.
- **H7 — Zero coupling in the published artifact.** `@oxagen/tacho` is one of three public npm packages (with `@oxagen/cli` and `@oxagen/skills`). It ships with no `@oxagen/*` runtime dependency, following the CLI's standalone-publish discipline (`apps/cli/scripts/prepare-standalone-publish.mjs`) and the usage-telemetry pattern of carrying its own copy of a schema with a test-only cross-check against the server package.
- **H8 — An app with no hook surface is connected, not unsupported.** The AI applications a non-developer runs — Claude Desktop and its kin — have no hook surface, and wrapping is therefore not available on them. They do have an MCP client config, so enrollment writes one Oxagen server into it and the collector's local gateway serves the workspace toolbelt under the mandate (§5.6). That is the `gateway` tier, and it is neither a degraded wrap nor a superset of one: wrapping is **broader and weaker** (it sees every action, but the hook runs in a process Oxagen does not own, so the record is `client_attested`), connection is **narrower and stronger** (Oxagen sees only what routes through it, but a denied call does not execute). No surface may put the two on a single "more governed / less governed" axis; ADR-078 §2 bans it in both directions.

Non-goals for v1: an egress proxy or eBPF ambient capture (`design/overview.md` §4(c)), the insurer attestation API (`oxagen-roadmap:docs/oxagen/specs/tacho/design/insurer-api.md`), and a Codex adapter. The event model reserves room for all three.

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
│  Mint = Biscuit tokens (roadmap adr-0003) · deny generations · emergency deny│
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

The session's body file is the one store for a run's content on the host (ADR-139). Everywhere else the content passes through is a hand-off: the spool holds a hook payload until the daemon drains it, and the daemon's terminal journal (`pending-session-ends.json`, named as `TachoPaths.pendingEnds`) holds one sealed batch per session until it lands in the WAL. A hand-off is retried, so `Wal.appendRecovered` writes only the bodies the body file does not already hold, keyed on the event id. Only the body file is swept by `dropBodies`, `purgeBodiesOutsideMandate`, and `compact`, so a body kept anywhere else is a body no mandate and no retention window reaches.

### 3.2 Performance stance

Unchanged from the design (R3): a telemetry hook costs one HTTP POST to loopback, answered after a local WAL append (target p50 under 5 ms, measured in the plan). An enforcement hook costs one process spawn of `tacho-hook` plus one local bundle evaluation; the network is on the path only for elevation. The plan carries a budget of 30 ms p95 for `tacho-hook` start-to-decision on a warm host; if a Node-based executable cannot meet it, the enforcement binary moves to a compiled target before GA, and the hook contract does not change.

Shipping a batch costs the batch, not the session. Each session's body file carries a byte-offset index beside it, `<session>.bodies.index`, so the 200 bodies of a batch are read at their offsets instead of found by a scan. The index is derived from the body file and rebuilt whenever the two disagree, so a body file already on disk is indexed on its first read and a file the retention sweep rewrites is indexed again. That first scan and the batch's reads both run off the synchronous path, so the daemon answers `/status` and its control-plane fetches while a long session is read. The daemon also remembers the byte each session's shipped cursor sits on in its event file, so `unshipped` and the health probe read the unshipped tail rather than the file. One measured host held a session of 16,436 model bodies in 7.38 GB, re-read all of it for every 200 events, and shipped nothing for nine hours (#3694).

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

Server-side code lives where every other capability lives: contracts in `packages/oxagen/src/contracts/tacho.*.ts`, handlers in `packages/handlers/src/tacho.*.ts`, routes in `apps/api/src/routes/v1/tacho.*.ts`, ClickHouse migrations in `packages/telemetry/src/migrations/`, Drizzle schema in `packages/database/src/schema/agent.ts`. A shared-schema package is not introduced; the published wrapper carries its own copy of the wire schema and a test asserts byte parity with the contract's zod-to-JSON-Schema output, as `apps/cli/src/telemetry/usage.ts` does for usage telemetry.

### 4.2 Why one package and not three

The design's R1 and R2 are only true if the Claude Code hook handler, the Claude Agent SDK hook callback, and the custom-agent `wrapTool` gate are the same function with three entry points. A second package per harness is the "per-framework connector sprawl" the governance review names as the risk to resist. The adapters are subpath exports so that a Codex adapter, when it comes, is one more subpath and not one more product.

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

Modeled on `create_stella_enrollment` (`packages/oxagen/src/contracts/telemetry.stella.enroll.ts`) because it already has the needed shape: an operator-only, session-authenticated, org-scoped capability that mints a purpose-locked API key and returns a signed claims document.

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

These do not enroll a host. They register an agent (`agent.definition.create` with `agent_type: "claude-agent-sdk"` or `"custom"`), receive an agent-scoped API key, and pass `{ agentKey, apiKey }` to `startSession` or `govern`. The collector is optional for them: if `tachod` is reachable the SDK uses it (shared chain, shared spool); otherwise the inline emitter chains and spools in-process to `~/.config/oxagen/tacho/spool/<agentKey>/` and ships directly. The trade is stated in the docs: an inline emitter cannot sign checkpoints with a host device key, so its checkpoints carry the agent key's fingerprint and its sessions score against the wider posterior (`oxagen-roadmap:docs/oxagen/specs/tacho/design/trust-scoring.md` §3).

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

Model calls have no hook. They come from Claude Code's OpenTelemetry log exporter: the enrollment writes into the settings `env` block `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>`, and `OTEL_LOG_TOOL_DETAILS=1`. `tachod` accepts `/v1/logs` and `/v1/metrics`, and turns each `api_request` record into an `llm_call` event (model, tokens by tier, cost, duration, `prompt.id`). Prompt and response bodies are **not** enabled (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_RAW_API_BODIES` stay unset); digests come from the hook payloads and the transcript, never from raw bodies in flight. The transcript is the second source of model calls: `tachod` tails each session's `transcript_path` and its subagents' transcripts, and folds every `assistant` record's `usage` into an `llm_call` frame, with the body when the bundle retains `model_call`.

A tool call seals one frame, whichever seams report it. The PostToolUse hook, the OTel `tool_result` record, the OTel tool span, and the transcript's `tool_result` block all carry the same `tool_use_id`, and the recorder used to seal a `tool_call` for each: nine calls in one session held twenty-seven frames, eighteen of them digest only (#3661). The first source to report a `tool_use_id` in a session family (the session and its subagents) seals its frame and a later sighting from another source seals nothing, except a sighting bringing a body the chain does not hold, which seals stamped `oxagen.tool_call_duplicate_of` so a reader still counts one call. The ledger is `ToolCallLedger` (`packages/tacho/src/claude-code/tool-call-dedupe.ts`), it is part of the recorder state a restart continues from, and ADR-140 records the decision and what it gives up. The root session's recorder owns this ledger and the model-call ledger for its subagents too, so a subagent's call reported on two chains counts once (ADR-168). An OTel record that names only a `tool_use_id` seals on the chain of the subagent whose hook named that call, and one that names only a subagent type while more than one subagent of that type is open seals on the session's chain stamped `oxagen.subagent_type_ambiguous`.

Hook payload handling is digest-first: `tool_input` and `tool_response` are hashed and size-counted at the collector, and `prompt` from `UserPromptSubmit` is digested the same way. Whether the bytes ship as well is the bundle's `retention` clause (§7.1). Under `digest_only` nothing ships. Under `content_exact` the host ships a body for every frame whose class is in `retention.classes`, after its redaction detectors have run and the digest of the redacted bytes is chained. The classes are `model_call` (`turn_start`, `turn_end`, `llm_call`, `subagent_stop`, `oxagen:message`), `tool_call` (`tool_requested`, `tool_call`, `token_denied`), and `approval_receipt` (`approval_request`); a kind outside that list has no body to ship. The mapping is `contentClassOf` in `packages/tacho/src/evidence/frame-body.ts`, and the class names are spelled as `RETENTION_CONTENT_CLASSES` in `@oxagen/run-ledger` spells them, because a class the host spells differently is a body that never ships.

### 5.5 Managed (enterprise) enrollment

`--managed` (or `--print-managed` for MDM tooling) writes the same hooks and env block into Claude Code's managed settings file (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux) together with `allowManagedHooksOnly: true`, `disableBypassPermissionsMode: true`, and the signed enrollment document. In this mode a user cannot remove the hooks from user or project settings, cannot run `--dangerously-skip-permissions`, and `tacho-hook` verifies the enrollment signature offline at every start. This is the design's "enterprise gateway" posture; the record still labels it `client_attested`, because the process remains one Oxagen does not run.

### 5.6 The single-use enrollment token (`oxagen agent enroll --token`)

The register flow (MC spec §7.2, App. E `enroll_host`; #2967) enrols a host without an operator session on the machine. `create_enrollment_token` (org Owner or Admin) mints a token for one registered agent — `oxe_1time_` and 26 Crockford characters, shown once, stored as its SHA-256 digest in `tacho.enrollment_tokens`, good for thirty minutes by default and sixty at most. The machine presents it to `POST /v1/tacho/enroll` (`enroll_host`, public, under the `/v1/tacho/*` pre-auth ceilings) with the same host facts as §5.2 and, when it ran inside a repository, the git remote.

`enroll_host` resolves the tenant from the token, locks the token row, and in that transaction mints exactly what §5.2 mints — the `tacho_host_v1` key, the signed claims under the domain of `tacho-enrollment-signing.ts`, the initial bundle — with the host bound to the token's agent (`tacho.hosts.agent_id`, `agent_principal_id`), so the host's agent key is the agent's `org_ns.ws_ns.slug` rather than a `cc-<hostname>` key, and every session it reports is that agent's run. The token is then marked used by that host. A second presentation is `conflict: token_used`, an expired one `conflict: token_expired`, an unknown one `not_found: token_unknown`, and every refusal increments `rejected_count` for the installer's "token rejected" screen. The response adds the agent id and the organization and workspace slugs the host did not know, which the host file records.

`oxagen agent enroll --token …` drives this path with the §5.1 routine; `oxagen tacho enroll` keeps the operator path. The first frame the new host ingests is what opens the organization's onboarding gate (`org.onboarding_state`; ADR-065).
### 5.7 Connected enrollment — an AI app with no hook surface

Enrollment is per host, and **a host carries a tier per harness, not one tier overall**. A machine with Claude Code wrapped and Claude Desktop connected is the normal case; `host.json` carries the harness list with a tier for each (`TACHO_HARNESS_TIERS`, `packages/tacho/src/wire.ts`). An app can in principle be both — a future harness with a hook surface *and* an MCP client — and nothing here assumes the two are exclusive.

**What enrollment writes.** For a connected harness there are no hooks and no env block. Enrollment writes one MCP server entry into the app's own client config (`claude-desktop-writer.ts`, `mcp-config-writer.ts`), pointing at `http://127.0.0.1:<port>/mcp` on the collector daemon. Every other entry in that file is left intact, exactly as §5.4's hook writer leaves non-Tacho hooks alone, and `unenroll` removes only ours.

**The app never holds an Oxagen credential.** The gateway holds it; the app holds a loopback URL. A non-developer will not paste a token into a JSON file, and asking them to would move the credential onto the least protected surface on the machine. The app *is* the credential.

**The gateway is a proxy, not a second materialiser.** H7 keeps `@oxagen/tacho` free of any `@oxagen/*` runtime dependency, so the gateway imports no `materializeTools`, no `mcp-rbac`, no `tool-budget`. It forwards the MCP JSON-RPC envelope to the workspace MCP endpoint over HTTPS. There is exactly one tool materialiser, one RBAC evaluation, one entitlement gate and one meter, and they are the ones that already exist on the control plane. The gateway runs no turn, calls no model and spawns no worker, so ADR-043 holds with no exception.

**Two keys, and the purpose of each is enforced.** Enrollment mints the host key (purpose `tacho_host_v1`) and a second key for the gateway (purpose `tacho_gateway_v1`); the gateway presents the second and never the first. The reason is not tidiness. An API-key principal has no `org_users` row, so `assertCallerRole` returns early for one and `checkIAM` takes a tier fast-path; a connected app forwarding under the host key would hold **owner authority over the workspace** and could reach MCP-only operations such as `set_model_credential`. `machineKeyDenial` (`packages/iam/src/machine-key-scope.ts`) runs in the kernel's IAM adapter *before* `checkIAM`, so it sits ahead of that fast-path and on the single `invoke()` path rather than in each handler. A key whose scope names a purpose may invoke only what that purpose is for, and an unrecognised purpose is allowed nothing. `tacho_host_v1` is held to the three calls the control client makes; `tacho_gateway_v1`'s mandate is a rule rather than a list — an `mcp`-surface capability that does not mutate and is not high-sensitivity. **A host with no gateway key serves no tools and never falls back to the host key**, which is the point of the split.

**A gateway-forwarded call's evidence names the credential, not the enroller.** `machineKeyDenial` decides whether a purpose-scoped key may invoke a capability at all, by the key's purpose, never by whose role grants it inherits. `fetchAuthz` (`packages/iam/src/fetch-authz.ts`) still resolves that inheritance for the full IAM resolver on an enterprise org, because that is what lets a machine key pass it. But the audit row `checkIAM` writes for the call now attributes it to the `tacho_gateway_v1` (or `tacho_host_v1`) credential itself, at every org tier, never to the Owner or Admin who enrolled the host. `resolveOperatorUserId` already refused a purpose-scoped key for the operator-management handlers that call it directly (mint, revoke, rotate); `fetchAuthz` now answers the same question the same way for every other capability's evidence, closing the disagreement #3151 found between the two.

**The list a connected app sees is the list it may use.** The control plane advertises the whole workspace toolbelt to any credential that can reach it, and the gateway key's mandate is narrower than that, so a forwarded `tools/list` showed the app tools that enforcement could only refuse once one was selected — and, where the mandate declares a `tool_ceiling`, counted forbidden tools toward it, refusing a toolbelt that would have fit. The gateway filters the result to the mandate before it counts or serves it. It does not evaluate the mandate: H7 means it cannot read a capability's surfaces, mutation or sensitivity, and a second copy of that rule in the collector is the drift H7 exists to prevent. The control plane evaluates `gatewayMayInvoke` over the registry and signs the answer into the bundle as `gateway_tools` (`gatewayMandateTools`, `packages/iam/src/machine-key-scope.ts`). The field is optional and absent means *no allowance this host has been told about*, the same reading `tool_ceiling` carries, so a bundle signed before the field existed serves what it is given rather than filtering everything away; an allowance that is present and empty is a mandate that permits nothing, and the gateway serves nothing. Because those two readings differ, the control plane never uses absence to express an empty permitted set: a populated registry whose capabilities the rule all refuses signs `gateway_tools: []`, and only an *empty* registry — a process that has imported no contracts, which is never a decision about what a gateway may call — leaves the field off. Omitting it for an empty permitted set would turn "permits nothing" into "serve everything", which is the outcome the field exists to prevent. `machineKeyDenial` remains the enforcement — filtering is what stops the app being offered what enforcement would refuse.

**A bundle field reaches only the hosts that can read it.** `policy_bundle` is validated by a `.strict()` schema on the host, so every new bundle field is a migration rather than an extension: a daemon or CLI built before the field rejects the *whole* mandate the day the control plane signs one in, bundle refresh fails on every poll and leaves the host on a stale mandate, and a fresh enrollment cannot parse its first bundle at all. The control plane deploys before the fleet upgrades, so that is the ordinary case. A host therefore declares which bundle fields its parser names — `TACHO_BUNDLE_FEATURES`, sent in the daemon health report on every control poll and in the enrollment facts — and the control plane records them on `tacho.hosts.bundle_features` and emits a gated field only to a host that named it. It is stored per host rather than read off each request because the control envelope publishes `bundle_etag` on ingest and command polls and the daemon refetches whenever it differs from the bundle it holds; a gate answered from the request would disagree between the two paths and refetch forever. It is read from the health report rather than from `wrapper_version` or `daemon_version` because both of those originate in `host.json`, which `enroll` writes once and no upgrade rewrites, so a host that upgrades in place would never be recognised. It tracks downgrades for the same reason: a daemon new enough to name a feature names it on every poll, so a health report that carries no `bundle_features` says the running parser predates the field, and the control plane clears the stored support rather than keeping it. Keeping it strands a rollback — the envelope goes on publishing the etag of a bundle carrying the gated field, and the host's `.strict()` parser rejects every refresh, with no later poll able to talk it back down. A poll that reports no health at all says nothing about the parser and leaves the column alone. `gateway_tools` is gated this way in phase 1: a host that has not advertised keeps the unfiltered `tools/list` it already had, which is the hole this field closes, and that is the price of not breaking it outright. Phase 2, once the fleet is upgraded, makes the field required and deletes the gate, at which point *absent* stops being representable — the optionality is a rollout constraint and never a decision that unfiltered is acceptable.

**The listener is now worth attacking.** Until the gateway, the collector's loopback listener was reached only by things Tacho installed itself. It is now a port any MCP client on the machine connects to, and the threat that matters is DNS rebinding, not a local process — a local process with the user's privileges can read `host.json` and have the bearer anyway. `loopback-guard.ts` therefore checks, on **every** request rather than only on `/mcp`, that `Host` names a loopback address and that `Origin`, when present, is a loopback origin; a native MCP client sends no `Origin`, which is why absence is permitted rather than required. Both run before the bearer compare, because a request that should never have reached us is not worth a constant-time compare.

**The tier can be routed around, and the size of the gap is reported.** A connected app's config is a file the user owns; nothing stops them adding a second MCP server beside ours, and a tool served by that server never touches Oxagen. Every connected surface therefore reports the count and the names of the other MCP servers configured in that app (`oxagenMcpPresence().otherServers`), because that is a fact the operator is entitled to. Closing the gap is not a change in this repository: it needs the vendor to offer an administrator-controlled policy file constraining which MCP servers a user may add, distributed by MDM — the same shape as §5.5's managed settings. Where a vendor offers one, Oxagen renders it and says so; where a vendor does not, Oxagen says the tier is advisory on that app. Tacho ships no watcher that fights the user for their own config file: a control that can be turned off by the person it constrains is theatre, and claiming it as a control is worse than not having it.

---

## 6. The evidence contract

### 6.1 Envelope

The `tacho/1.0` envelope of `design/trace-model.md` §1 is adopted verbatim: `v`, `event_id` (ULID), `agent { agent_id, fleet_id, runtime, wrapper_version, attestation }`, `session_id`, dense `seq` from 0, `ts` (the CGP timestamp profile: uppercase `T`, uppercase `Z`, UTC only), `kind`, `fidelity`, `span`, `body`, `content { digest, bytes_ref?, redactions[] }`, `prev_hash`, `hash`. Two narrowings:

- `agent.agent_id` is the ADR-024 `agentKey`; `agent.fleet_id` is the workspace public id. `runtime` gains the values `claude-code` and `claude-agent-sdk`.
- `session_id` is the harness session id where the harness has one (Claude Code's UUID); the control plane derives `session_uuid = uuidv5(NS_TACHO_SESSION, "<hostEnrollmentId>/<session_id>")` and `event_id_idem = "evt_" + sha256(session_uuid, seq)`, so re-sends after a lost ack land in the same ClickHouse row. Derivation happens in the collector, following the reasoning in Stella's drain analysis §4: the client must be able to re-send and land in the same place.

Chain rule, checkpoints, gaps as chained events, and digest-preserving redaction are as designed (§2, §3 of the trace model). Checkpoints are signed by the host device key and countersigned on ingest. Merkle anchoring of checkpoint hashes is phase D.

**Bodies (ADR-058).** `content.bytes_ref` on the stored row is server-owned: a `bytes_ref` a host sets in the envelope names a producer-side location, stays under the chained hash, and is replaced on the ClickHouse row by the reference the control plane wrote. A host that retains bodies ships them next to the events in the same batch, `bodies[]` of `{ event_id_idem, content_type, bytes_base64 }`, at most one per event and at most `TACHO_MAX_BODY_BYTES` (1 MiB) each, after it has redacted and digested the bytes and chained `content.digest`. The control plane verifies each body before any row references it: the body names an event in the batch, that event chained a digest, the bytes hash to it, and the bytes carry nothing the platform's own redaction detectors would strip. A body that fails is refused, the event is recorded without one, and the ingest response names the refusal in `body_rejections[]` (`unknown_event`, `no_content_digest`, `digest_mismatch`, `credential_detected`, `retention_digest_only`) so the collector can correct itself. An accepted body is written through the evidence store (`@oxagen/run-ledger`, `evidence-store.ts`) as an encrypted, content-addressed object under the tenant's prefix, and the reference is stamped on the ClickHouse row's `bytes_ref`. A batch shipped to a `digest_only` workspace has every body refused; the bundle's `retention` clause (§7.1) tells the host so in advance.

### 6.2 Event kinds

The design's fourteen kinds stand. This spec adds, additively, the kinds a harness adapter needs that a wrapped SDK object did not:

| Kind | Emitted when | Why it is new |
|---|---|---|
| `turn_start`, `turn_end` | a user prompt is submitted; the assistant stops | the CGP journal is turn-scoped and the design had no turn boundary |
| `tool_requested` | after `PreToolUse` allows, before execution | pairs with `tool_call` to give the CGP `tool_call` / `tool_result` pair and to catch a call that never resolved (crash) |
| `policy_decision` | every standing-grant evaluation, including harness-originated denies | a deny is evidence even when no elevation was attempted |
| `subagent_start`, `subagent_stop` | Claude Code spawns / finishes a subagent | subagents are child sessions with their own chain, linked by `body.parent_session_id` and the spawning `tool_use_id` |
| `oxagen:compaction`, `oxagen:config_change`, `oxagen:unobserved_session`, `oxagen:hooks_removed` | harness lifecycle and tamper signals | vendor-namespaced per CGP U3 |
| `proof.observed` | a witness runner (Stella's local ladder, or the Oxagen witness runner) reports a verdict on the worker's run | Mission Control spec §8.5; the body is `proofObservedBodySchema` in `@oxagen/run-evidence`, carried opaquely by this package and validated by the control plane's ingest contract (ADR-064) |

`body` shapes for the harness kinds are fixed in the package's zod schema and its published JSON Schema; the representative bodies in the design (`llm_call`, `tool_call`, `network`, `approval_*`, `token_*`) are unchanged.

### 6.3 Fidelity and enforcement tier

`fidelity` keeps its three values. A Claude Code hook event is `sdk` fidelity: hooks are the harness's own first-class surface and cover every tool call. The session record additionally carries:

- `enforcement_tier`: `gateway` when every tool in the session routed through the Oxagen MCP endpoint or a reverse-RPC engine; `harness` when Tacho gated tools via hooks; `observe` when the bundle was in observe-only mode.
- `completeness.gaps[]` in the run-evidence vocabulary: `model_calls` (OTel exporter absent or unreachable), `tool_bodies` (retention off), `hooks_partial` (a hook entry missing for part of the session), `unobserved_tail` (process ended without `SessionEnd`). The control plane adds, at seal, the gaps it observed itself (ADR-058): `chain_break` (a link failed to verify), `telemetry_gap` (the daemon reported dropped events), `digest_only` (the workspace's retention policy keeps digests alone), `body_missing` (a frame owed a body and no whole body was retained, under the body rule in the next item; the session row counts `content_frames` and `body_frames`, and the gap is their difference), `tool_bodies` (the session counted tool calls and `tool_body_frames` is zero).
- The body rule is `frameOwesBody` and `bodyIsPartial` in `packages/tacho/src/evidence/replay-grade.ts`, and both seals read it. A content-bearing kind, `llm_call` or `tool_call`, owes a body whether or not it chained a digest. Any other kind owes one when it chained a digest. A later sighting of a model call, stamped `oxagen.llm_call_duplicate_of` and carrying no digest, owes nothing, because the frame sealed first holds the call's content. A body stamped `oxagen.request_body_omitted` or `oxagen.response_body_omitted` holds one half of the exchange. The control plane stores and serves it, and it does not count toward `body_frames`. The in-app assistant's ledger seal applies the same rule. Its recorder writes a `null` body for a model call that was cancelled or failed before the provider answered, so a call that returned nothing is not a gap.
- `replay_grade` on the session row, computed once by `computeReplayGrade` (`packages/tacho/src/evidence/replay-grade.ts`) from the gaps and the tier when `agent_stop` seals the session: `inspect` on any gap that hides content or breaks the chain; `view` when every body is present; `fork` needs `view` on a `gateway`-tier session; `retry` needs a harness that reports a reproducible run, which no wrapped harness does, so a wrapped session never grades `retry`. A gap outside the vocabulary grades `inspect`. The grade is never raised after the seal. A session its host starts again after the seal (ADR-172) is graded afresh at its next seal.

These fields are what the review's honesty rule is enforced by: the fleet UI and attestation reports read them and cannot render a stronger word than the tier or the grade allows.

**A connected host's record has a different shape, and the difference is the claim an auditor will test.** A wrapped session has a boundary (`SessionStart` … `SessionEnd`), the user's prompt, model calls and token counts, the harness's own Bash and file edits, and one hash chain per session — all of it `client_attested`, because the harness is trusted to honour a deny. A connected host has **no session at all**, only individual calls: no prompt, no model calls, no visibility into anything the app does outside the gateway, including tools served to it by any other MCP server. What it does have is stronger for what it covers — a denied call did not execute, because the kernel refused it on the server — and its records are sealed per call on the host chain with `enforcement_tier: "gateway"`. A connected row therefore has no step record, and nothing in the app, the CLI, the docs or an attestation report may present one.

### 6.4 Projections

1. **OpenTelemetry** as designed (`design/trace-model.md` §4): `tachod` and the control plane can export OTLP with GenAI semantic conventions and `oxagen.tacho.*` attributes.
2. **CGP export provider** as designed (§5): sessions as `episode` frames, incidents as `fact` frames, distilled behaviour as `memory`, chains as `graph` relations, `DataFlow.egress_scopes: ["local-only"]` by default.
3. **CGP host-trace journal.** `contextgraph-trace` (`TRACE_FORMAT = "contextgraph-trace/0.1-sketch"`) is the closest thing CGP has to agent conformance: an NDJSON journal graded by eight replay oracles. CGP does not define a "conformant agent" (SPEC §12 binds providers and hosts), so this spec claims: **every Tacho session exports a journal that passes all eight oracles, and the package ships the oracle port and pinned upstream fixtures that prove it.** The mapping:

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

For Claude Code the `assembly-budget-honesty` oracle passes trivially: no frames are declared, so there is no arithmetic to drift. The export marks `frames_source: "none" | "oxagen-mcp"` in the journal's `session_start.agent` suffix so a reader knows which oracles checked served frames. The package pins `contextgraph-trace/fixtures/` (golden, golden-resume, one `trip-*` per oracle) byte-for-byte with an upstream-commit manifest and a drift gate, the ADR-035 pattern applied to the trace crate.

### 6.5 Storage

Following the three-plane split Oxagen already uses and Stella's drain analysis §5:

- **ClickHouse** `tacho_events`: `ReplacingMergeTree(received_at) ORDER BY (org_id, workspace_id, event_id_idem)`, columns for the envelope scalars, `body` as JSON string, `content_digest`, `prev_hash`, `hash`, `fidelity`, `received_at`. Tool events are additionally projected into the existing `tool_invocations` with `surface: "tacho"` and `external_provider: "claude-code"`; `llm_call` events into `token_usage`. Retention follows the existing TTLs.
- **Postgres** `agent.tacho_hosts` (enrollment: agent id, principal id, device public key, platform, status `active|paused|suspended|revoked`, bundle version served, last seen), `agent.tacho_sessions` (session uuid, host or agent, harness, started/ended, outcome, enforcement tier, final chain hash, checkpoint count, gaps, parent session). Approvals reuse `agent.approval_requests`; every gate decision the control plane makes reuses `iam.authorization_decisions`.
- **Evidence** (phase C): each sealed session produces a `RunEvidenceEnvelopeV1` and the platform finalizes a `RunEvidenceManifestV1` with `evidence_authority: client_attested` and a replay grade computed from the gaps. `ingest_run_evidence` does not exist in TypeScript yet (the Postgres foundation does); this wrapper is its first consumer. Raw bodies, when retained, go to tenant-encrypted blobs and never to ClickHouse or Neo4j: the object lives under `evidence/<orgId>/<workspaceId>/bodies/<key id>/<sha256>` through `@oxagen/storage`, the ClickHouse row carries only its reference (`bytes_ref`, `evb:v1:<key id>:<sha256>`), and `get_run_frame_body` reads it on demand inside the tenant scope and checks the bytes against the chained digest before answering (ADR-058). `tacho.sessions.replay_grade` and `completeness_gaps` are written by the seal (§6.3); `tacho.sessions.content_frames`, `body_frames` and `tool_body_frames` are the counters it grades `body_missing` and `tool_bodies` from; `view` needs at least one retained body, and an `observe`-tier session grades `inspect` (Mission Control spec §8.4).
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

*Amended 2026-09-24 (#3944): an unverified bundle denies mutating tools in either mode, `ask` rules are checked before `allow` rules, and the host renews an unchanged mandate's signature.*

For every `PreToolUse`, `tacho-hook` evaluates, in order:

1. **Host and session status.** A paused or suspended host or session is denied with the operator's reason.
2. **The signature.** An unverified bundle is treated as absent. Read-only tools are allowed and every other tool is denied, whatever `mode` or `tools` declarations the bundle claims. An unsigned `host.json` therefore cannot switch enforcement off or declare `Bash` read-only. A bundle signed for another host counts as unverified.
3. **Containment.** A verified enforce-mode mandate that requires the contained tier denies every tool in a session the launcher did not start (ADR-152).
4. **Freshness.** A `deny_generation` newer than the cached bundle marks it stale, and so does a bundle the control plane has not confirmed within its signed window. A stale bundle allows read-only tools and requires a synchronous re-evaluation for the rest, failing closed if the control plane is unreachable.
5. **`deny` rules.** A match is denied. Deny always wins.
6. **`ask` rules.** A match falls through to Claude Code's own permission flow, which surfaces as `PermissionRequest` and thereby to elevation.
7. **`allow` rules.** A match is allowed.
8. **No rule.** The call falls through to Claude Code's permission flow, as for `ask`.

Ask before allow is Claude Code's own precedence (deny, then ask, then allow). A narrow `ask` such as `Bash(git push*)` still asks when a broad `allow` such as `Bash(*)` also matches. In `observe` mode, a verified bundle's rule evaluation is recorded and the answer is allow.

The etag covers policy content only, so an unchanged mandate answers `not_modified` on every poll and the signed copy on disk keeps its first `expires_at`. The daemon counts each `not_modified` as a confirmation, but only in memory. Once the cached copy is past half its signed window, the daemon polls without the etag, and the control plane signs the unchanged mandate again with a new window. A restart, or the hook when the daemon is down, then reads a fresh bundle rather than one stale since the last policy edit.

The host takes a same-etag copy only when its window starts later than the one it holds, so a window never moves back. A cached copy that does not verify is never confirmed by its etag, because an edit to `host.json` keeps the etag it was signed with. The daemon fetches it again without the etag and replaces it with the verified copy, whatever that copy's window.

Tool calls to the Oxagen MCP endpoint (`mcp__oxagen__*`) are not evaluated here at all; the kernel evaluates them on the server, and those calls are what earn a session the `gateway` tier.

### 7.3 Elevation and tokens

`PermissionRequest` is the elevation point. `tacho-hook` emits `approval_request`, then calls `request_tacho_elevation` with the canonical action (`tool:<name>`, resource, digest of the input, the requesting span, the trust tier). The handler runs `authorizeExternalCapability("claude.<tool>", ctx, "require_approval")`; an `allow` mints a token; `require_approval` creates an `agent.approval_requests` row and the handler holds the request on the existing `waitForApproval` listener up to the hook timeout (default 600 s, configurable per bundle); a resolution through the existing `resolve_approval` capability (from the `/approvals` queue, Slack, or the CLI) returns `allow` or `deny`. The token is a Biscuit v2 as decided (design ADR 0003): bound to `agentKey`, session, exact action, expiry (default 120 s), use limit, and the approval event id, verified offline by `tacho-hook` against the cached mint keys, then `token_use` and `behavior: allow`. Deny or verification failure is `token_denied` and `behavior: deny`; the hook's `permissionDecisionReason` carries the policy id or approver so the model and the human see why.

While an elevation is pending, the collector shows it in `oxagen tacho status` and the control plane shows it in the approvals queue with the four-hop chain (`oxagen-roadmap:docs/oxagen/specs/tacho/design/approval-tokens.md` §4).

### 7.4 Commands: pause, resume, cancel, steer, message, revoke

*Amended 2026-09-14 (issue #2953, ADR-056): `steer` joins the set with a delivery mode, the status vocabulary is the Mission Control spec's §7.4 set, and the control channel is `tacho.commands.v2`.*

`dispatch_command` writes one `tacho.control_commands` row per recipient run (one run, every live run of an agent, or every live run in the workspace); `revoke_tacho_enrollment` writes the host-level `revoke`. The collector receives commands in the next ingest response or, when idle, from the long-poll `fetch_commands` (`POST /v1/tacho/commands`, body `schema: "tacho.commands.v2"`). Effects:

| Command | Effect on an enrolled Claude Code session | Guarantee |
|---|---|---|
| `pause` | next `UserPromptSubmit` and `PreToolUse` are denied with the reason; the current tool call completes | guaranteed at the next boundary |
| `resume` | clears the pause | guaranteed |
| `cancel` | every further prompt and tool call is denied; `tachod` sends `SIGTERM` to the `claude` process it has matched to the session (by transcript path and cwd) | soft cancel guaranteed; process termination best effort and recorded as `oxagen:kill_attempted` with the outcome |
| `steer` | injected as `additionalContext` at the next `UserPromptSubmit` (or `SessionStart` for a resumed session) and chained as `oxagen:command_applied` with `command.name = steer`, `command.requested_mode`, `command.delivery_mode`, `command.degraded_reason` and `command.interrupted = 0` — the Mission Control spec's `control.steer` frame in the wrapper vocabulary | delivered at the next boundary; see the degradation rule below |
| `message` | as `steer`, with `command.name = message` | delivered at the next boundary |
| `revoke` (host) | host status `suspended`; every session denied at its next boundary; API key revoked; `tacho-hook` reads `suspended` from the bundle and denies even if the daemon is down | guaranteed while the hooks are installed; visible as `hooks_removed` if not |
| deny-generation bump / emergency deny | the ingest response carries the new generation; the cached bundle is stale (§7.2) | guaranteed for non-read-only tools |

**Delivery modes and the degradation rule.** A `steer` or `message` carries a requested mode from the Mission Control spec §7.3 (`next_step`, `interrupt`, `turn_boundary`). The hook adapter injects at the next prompt boundary and cannot stop a call in flight, so `next_step` and `turn_boundary` land as asked and `interrupt` degrades to `next_step`; the control plane resolves this at dispatch and records `requested_mode`, `delivery_mode` and `degraded_reason = harness_tier` on the row and on the frame. Every interface shows the mode that was achieved, never the one requested. A session at `observe` tier has no adapter in its path: a command addressed to it directly is refused, and a broadcast records it as `failed` with `observe_tier`.

**Status vocabulary.** A command row moves through `queued` (accepted by Oxagen), `sent` (drained onto the control channel), `received` (the collector has it), `acknowledged`, `applied` (the effect is in the record; the only success status, with `applied_at_seq` naming the frame), `cancelled` (withdrawn or superseded by a later command of the same kind on the same run before delivery), `expired` (the expiry passed with no boundary reached) or `failed` (the collector refused it, or the session was gone). The collector acknowledges in the five statuses it can assert about itself — `received`, `acknowledged`, `applied`, `expired`, `failed`; `sent` is Oxagen's act and stays Oxagen's to record. Who writes `expired` follows who owns the row: a row is Oxagen's while `queued` and the collector's once it leaves on the wire. Oxagen writes `expired` on a `queued` row past its expiry at the host's next poll, and `list_commands` derives the same word for a `queued` row before that poll; a row the collector holds reads as recorded until the collector settles it. The collector checks the deadline at receipt and again at the boundary that would inject a steer, and acknowledges `expired` (`expired before a boundary`) for an item whose expiry passed with no boundary reached, chaining no frame for it. An acknowledgement that arrives after the clock passed lands, so the report and the run's chain never disagree; an interface reads `expires_at` to show a held row as past expiry and awaiting the host.

These are the same operations `stella-serve` exposes as `/pause`, `/resume`, `/cancel`, `/steer`; the names are aligned so the fleet UI has one verb set.

### 7.5 Governed context injection

*Amended 2026-09-24 (#3944): the prefix fits the smallest harness limit, the signed manifest lists at most 1,900 items, and one hook answer carries at most 9,500 characters.*

The bundle's `context.system` is injected at `SessionStart` and after `compact` via `additionalContext`. It is authored on the control plane through the same closed operation set the lifecycle framework already uses (`prepend_system_context` / `append_system_context` only; nothing rewrites the harness's instructions), it is IAM-gated, and the injected text's digest is chained as part of `agent_start` so a replay shows what the agent was told. The control plane fills it from the workspace's active `must` and `should` context records (ADR-091). The host accepts 16,384 characters, but the harness it hands the text to reads less: Claude Code keeps 10,000 characters of `additionalContext` and swaps anything longer for a file path and a preview, and Codex caps it near 2,500 tokens. Since ADR-144 the text is assembled by `assembleSteering` (`packages/steering-assembler`), which ranks every active record by force and then by activation instant and fits the `must` and `should` ones to `PREFIX_BUDGET_TOKENS`: 2,000 budget tokens, at most 8,000 characters, under the smallest limit in `HARNESS_CONTEXT_MAX_CHARS`. The bundle carries the assembler's manifest beside it as `context.manifest` for a host that advertised `steering_manifest`. The host parses that manifest with at most 2,000 items, so the control plane lists every included record and drops the oldest cut ones past 1,900 (`capManifestItems`, `packages/handlers/src/lib/tacho-steering.ts`), which leaves room for the steers the host appends; the manifest's `cut` count still counts every candidate. Such a host seals the manifest into the session's chain as a `steering.manifest` frame at `SessionStart`, with the steers it delivered beside the prefix appended as included items, so the run record names which records the agent saw and which were cut, and why.

One hook answer hands the agent at most 9,500 characters, the prefix and any queued steers together (`ADDITIONAL_CONTEXT_MAX_CHARS` in `packages/tacho/src/collector/hook-handler.ts`). A steer that does not fit beside what the answer already carries waits for the next boundary, and one longer than a whole answer is acknowledged `failed`. `dispatch_command` accepts at most 8,000 characters of steer or message text (`STEER_TEXT_MAX`), so every steer it accepts fits an answer. The hook's frame records how many characters the answer handed over as `oxagen.delivered_chars`, to set against the harness's limit.

> **Status (2026-09-21).** The delivery path is built, and since Phase 0 of the refactor path approved on 2026-09-18 merged (PR #3289, `c9db463e9`, ADR-091) the workspace's active `must` and `should` records travel on it: `readWorkspaceSteering` (`packages/handlers/src/lib/tacho-steering.ts`) compiles them and `unsignedBundle` (`packages/handlers/src/lib/tacho-host.ts`) carries the text, `null` only when there are none. On governed calls, `permissions.{allow,deny,ask}` now carry the agent's own tool RBAC and the workspace's external-tool decision rules, mapped onto the harness's permission shape (`resolveHostMandate`, `packages/handlers/src/lib/tacho-mandate.ts`); a decision rule naming an internal MCP server id rather than a server:tool glob does not translate here and keeps governing only the in-app agent's own calls. `budget.mode` is `"enforced"` only when the agent's own definition names a `per_run_micros` figure; otherwise it stays `"observed"`. The loopback model proxy refuses against `session_limit_usd` (`session_budget_exceeded`). A `per_day_micros` figure is not signed, because nothing on the host keeps a day's spend (#3728, 2026-09-22). Phase 1 puts one assembler behind the compile step (`oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md` §10.4 and §10.5, `oxagen-roadmap:docs/oxagen/specs/mission-control/plan.md` §8). Phase 4 is in build on branch `gateway-model-proxy` (issue #3299, ADR-094).

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

Stella implements this contract natively (`tacho-core`, `oxagen-roadmap:docs/oxagen/specs/tacho/design/examples/rust-stella.md`): the executor's `tool.call.requested` bus event is the `PreToolUse` equivalent, `policy.evaluated` maps to `policy_decision`, its `ApprovalRequest`/`ApprovalResponse` types carry elevation, and `stella-serve`'s `/pause` `/resume` `/cancel` are the command set. Its existing signed-enrollment machinery (`enterprise_telemetry.rs`) is what §5.2 copies, so the Stella side of enrollment is a second event class on an existing document. A `stella-serve` session is `gateway` tier by construction and needs no hooks; a workstation Stella session is `client_attested` like Claude Code. The Stella-repo plan is a numbered sub-plan of this spec (plan §PR 9) and a Stella `docs/spec/` companion, following the `serve-surface.md` pattern.

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
13. The session record's `enforcement_tier` is `gateway` only when every tool call in it was served by the Oxagen MCP endpoint or a reverse-RPC engine; the fleet UI, exports, and reports never use the word "enforced" for a `harness` or `observe` session, and no surface ranks the two tiers on a single "more governed / less governed" axis.
14. Sealed sessions finalize a `RunEvidenceManifestV1` with `evidence_authority: client_attested` and a replay grade derived from `completeness.gaps[]`; the manifest verifies offline with the published platform key.
15. Tenant identity is never taken from an ingest body: a batch whose events name another workspace is rejected, and the accepted rows carry the API key's scope.
16. `@oxagen/tacho` publishes with no `@oxagen/*` runtime dependency, and its wire schema is byte-identical to the contract's generated JSON Schema in a test.
17. A telemetry hook round-trip (`PostToolUse` to acknowledged WAL append) measures p50 under 5 ms and `tacho-hook` start-to-decision measures p95 under 30 ms on the reference laptop; the numbers are recorded in the plan's verification section.
18. `oxagen tacho unenroll` leaves `~/.claude/settings.json` with every non-Tacho entry intact, stops the service, and the host shows `revoked` on the fleet page.
19. On a machine with Claude Desktop installed, enrollment writes exactly one Oxagen MCP server into its client config, leaves every other entry byte-identical, and the app lists the workspace toolbelt after a restart without any credential in that file; `unenroll` removes our entry and only ours.
20. The gateway forwards under the `tacho_gateway_v1` key and never the host key: a host whose `gateway_api_key` is absent serves no tools and returns a refusal naming the missing credential rather than falling back, and a `tacho_host_v1` key presented to any capability outside the three the control client makes is denied by `machineKeyDenial` before `checkIAM` runs.
21. A connected app's `tools/list` carries only what the mandate permits: the gateway filters the forwarded result against the bundle's `gateway_tools` before it counts it against any `tool_ceiling`, a bundle that declares no allowance is served unfiltered, and a bundle that declares an empty one serves no tools.
22. A host that has not advertised `gateway_tools` is served a bundle with no such key at all, which the bundle schema it shipped with parses; a host that has advertised it is served the list. The advertisement is recorded at enrollment and refreshed from every control poll, so a host that upgrades in place is served the field on its next poll without re-enrolling.
23. A request to the loopback listener whose `Host` header names a non-loopback name, or whose `Origin` is a non-loopback origin, is refused before the bearer is compared — on every path, not only `/mcp` — and a native MCP client that sends no `Origin` is served.
24. A machine with Claude Code wrapped and Claude Desktop connected reports both harnesses with their own tier from one enrollment, and every connected surface shows the count and names of the other MCP servers configured in that app.
25. A gateway-forwarded call that reaches an org-admin capability outside the mandate (`set_model_credential`, `delete_model_credential`) is refused by `machineKeyDenial` naming the capability, at every org tier including non-enterprise, and its audit row attributes the call to the `tacho_gateway_v1` credential, never to the Owner or Admin who enrolled the host (ADR-078 amendment 2026-09-19, #3151).

## 15. Open questions a maintainer owns

1. Whether the host agent record should be one per host (this spec) or one per host × repository, which would give per-repo `agentKey`s at the cost of registry sprawl. Recommendation: one per host; the session carries `cwd` and the repository binding, and lineage projects per repo.
2. Whether `Stop` should ever block (Claude Code allows a hook to return `decision: block` to keep the agent working). Deferred; it is the "duty cycle" half of the tachograph metaphor and belongs with trust scoring.
3. Where the `/approvals` queue lands in navigation (review Phase 3). This spec depends on it existing; it does not decide its placement.

When the cached retention mandate is unproven, an event with a retained body waits with its session suffix. This preserves the dense chain and keeps the body in the same ingest request as its event. Other sessions continue to drain, even if the held session fills a batch. The hold ends 24 hours after the event timestamp, which survives a daemon restart. An invalid or future timestamp releases immediately. Release sends the event body-missing and logs the reason and count. A proven narrowing still drops the body and ships the event. The hold itself logs at most one line every five minutes per host, because the drain that finds it runs on the one-second control tick and an outage of the control plane would otherwise write 86,400 identical lines a day.

SessionEnd persists its pending envelope and registry state before acknowledging the hook. The Git lane records the final worktree observation before sealing the session. An unavailable Git read produces no observation, and still completes the seal. A restart resumes the pending final read. A SessionEnd carrying the session's first working directory applies it before the daemon decides whether a final read is possible, so a session first seen from OTel or a transcript still closes with a worktree observation. A reconciliation the fifteen-second interval turns down waits out that interval before its probes run again, rather than respawning them on every tick.
