# Tacho Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command enrolls a machine; from then on every Claude Code session on it is observed, policy-gated, and evidenced by Oxagen through the same contract Claude Agent SDK agents, custom agents, and Stella use. See `spec.md`.

**Architecture:** `@oxagen/tacho` (leaf package, published) carries the core, three adapters, and the per-host collector. The control plane adds five capabilities through the standard contract → handler → route → MCP → CLI → docs parity stack. The hash-chained `tacho/1.0` stream is the record; OTLP and the CGP host-trace journal are projections. Claude Code is governed through hooks (`command` hooks for enforcement, `http` hooks for telemetry) plus its native OpenTelemetry export.

**Tech Stack:** TypeScript 6, Zod 3, Hono, Drizzle/Atlas, ClickHouse, Postgres `LISTEN/NOTIFY` (existing approval listener), `@contextgraphprotocol/typescript-sdk`, `biscuit-auth` (wasm), Ed25519 via Node `crypto`, SQLite WAL (`better-sqlite3` or `node:sqlite`), esbuild single-file bundling (existing CLI pipeline), launchd / systemd user units.

## Global Constraints

- Tenant identity never comes from an ingest body; the API key scope stamps it (`packages/telemetry/src/tenant.ts:chInsert` semantics).
- Every gate decision the control plane makes writes an `iam.authorization_decisions` row; an unrecorded decision is a deny (`kernel.ts` `decision_not_persisted` rule).
- The published package has no `@oxagen/*` runtime dependency. Shared schemas are copied and parity-tested, never imported.
- Enforcement hooks are `command` hooks that fail closed against the cached bundle; telemetry hooks are `http` hooks that fail open with a chained `telemetry_gap`.
- `seq` is dense per session and assigned at the collector before any network I/O; nothing is shipped that is not first in the WAL.
- Timestamps use the CGP profile (`YYYY-MM-DDTHH:MM:SS(.fff)Z`, uppercase, UTC).
- No word stronger than the session's `enforcement_tier` appears in any UI string, export, or doc.
- Run only package-scoped tests named below. Never run the repository-wide test suite.

---

## PR Dependency Map

| Order | Pull request | Repository | Merge gate |
|---|---|---|---|
| 0 | Spec, plan, re-homed design (this PR) | `oxagen` | Docs links resolve; `cgp-website` gets a follow-up PR replacing `docs/design/tacho/` with a pointer |
| 1 | `packages/tacho` core: envelope, chain, WAL, trace projection + oracle port | `oxagen` | Envelope fixtures round-trip; chain verifies; all eight ported oracles pass `golden*.ndjson` and each `trip-*` fails exactly its check; fixture drift gate green |
| 2 | Control-plane capabilities and storage (enroll, ingest, bundle, control) | `oxagen` | Full parity stack per capability; `pnpm check:manifest` clean; ingest rejects foreign-tenant bodies; migrations Atlas-generated |
| 3 | Collector `tachod`, `tacho-hook`, Claude Code adapter, enrollment | `oxagen` | Criteria 1, 2, 3, 9, 17, 18 pass on the reference laptop; recorded in Verification |
| 4 | `oxagen tacho` CLI commands and docs | `oxagen` | `oxagen tacho enroll\|status\|unenroll\|export\|verify` delegate to the package; docs published |
| 5 | Claude Agent SDK adapter and custom-agent SDK | `oxagen` | Criterion 12; `design/examples/typescript/wrap-vercel-ai.ts` becomes a runnable example under test |
| 6 | Authority: bundle compilation from IAM, elevation, Biscuit mint and verify, commands, kill switch | `oxagen` | Criteria 4, 5, 6, 7, 8, 13 |
| 7 | `client_attested` evidence: session seal → `RunEvidenceEnvelopeV1` → `ingest_run_evidence` | `oxagen` | Criterion 14; first consumer of `@oxagen/run-evidence` |
| 8 | Fleet page (hosts, sessions, flight recorder) and `/approvals` queue hooks | `oxagen` | Criterion 6 UI half; usability review |
| 9 | Stella native `tacho-core` and Codex spike | `stella`, `oxagen` | Stella sub-plan approved as a `docs/spec/` companion; spike outputs a mapping table or a proxy-fidelity note |

PR 1 and PR 2 are independent and may proceed in parallel. PR 3 needs both. PR 6 needs PR 3 and PR 5 for the shared `handleHookEvent`. PR 7 needs the `ingest_run_evidence` contract, which is its own first task. PR 8 may start after PR 2 against fixtures.

## Merge and Rollout Order

- [ ] Merge PR 0. Open the `cgp-website` pointer PR the same day so two copies of the design never diverge.
- [ ] Merge PR 1 and PR 2 in either order; neither is user-visible.
- [ ] Merge PR 3 with the bundle defaulting to `mode: "observe"`. Enroll the maintainers' own machines first (dogfood replaces `tools/scripts/claude-telemetry-logger.ts` and `backfill-claude-telemetry.ts`, which are deleted in PR 4 once parity with `internal.claude_sessions` is shown).
- [ ] Merge PR 4 and PR 5. Publish `@oxagen/tacho` at the monorepo version behind a `next` dist-tag until PR 6 lands.
- [ ] Merge PR 6 with `mode: "enforce"` opt-in per workspace. Flip the dogfood workspace first; watch `policy_decision` volume and elevation latency for a week before offering it to customers.
- [ ] Merge PR 7; replay grades appear on the fleet page.
- [ ] Merge PR 8; promote the package to `latest`.
- [ ] PR 9 follows on its own cadence in the Stella repo.

## Cross-PR Contract Locks

- [ ] Envelope version `tacho/1.0`; harness kinds added in `spec.md` §6.2 are additive and namespaced where vendor-specific.
- [ ] Public id prefixes: `thst_` host enrollments, `tses_` sessions, `tcmd_` control commands, `ttok_` capability tokens, `tchk_` checkpoints. Reserve them in the prefix registry alongside the run-evidence prefixes.
- [ ] API key scope purpose `tacho_host` (host) and `tacho_agent` (SDK agent); `create_api_key` refuses both.
- [ ] HMAC domain `oxagen.tacho.host-enrollment-signature.v1`, canonical bytes as in `stella-enrollment-signing.ts`, with a conformance vector fixture beside the Stella one.
- [ ] Deterministic ids: `session_uuid = uuidv5(NS_TACHO_SESSION, "<hostEnrollmentId>/<harness session id>")`; `event_id_idem = "evt_" + sha256(session_uuid ‖ seq)`; `effect_id = sha256(session_uuid ‖ tool_use_id ‖ target)`. Namespaces frozen in the package and the handler; a fixture asserts both derive the same values.
- [ ] `sha256:<64 lowercase hex>` everywhere a digest crosses a boundary; RFC 8785 JCS for object digests (reuse `packages/run-evidence/src/digest.ts` semantics, copied into the leaf package with a parity test).
- [ ] Journal `trace_format` pinned to `contextgraph-trace/0.1-sketch`; fixture manifest records the upstream commit.
- [ ] Hook marker: every settings entry Tacho writes carries `"_tacho": "<hostEnrollmentId>"`; the writer and unenroller match on it and nothing else.

---

## PR 1 — `packages/tacho` core

**Files:**

- Create: `packages/tacho/package.json` (`name: @oxagen/tacho`, `private: false`, `exports` for `.`, `./claude-agent-sdk`, `./claude-code`, `./collector`, `./trace`; `bin` for `tacho`, `tacho-hook`, `tachod`)
- Create: `packages/tacho/src/envelope.ts` (zod schema for `tacho/1.0`, kinds, bodies), `src/digest.ts`, `src/chain.ts`, `src/ids.ts`, `src/timestamp.ts`
- Create: `packages/tacho/src/wal.ts` (SQLite: `events(session, seq, hash, json)`, `UNIQUE(session, seq)`; `checkpoints`), `src/spool.ts` (lease, batch, ack, retry with jittered backoff, bisection on terminal-row rejection, poison-row quarantine; port of the semantics in Stella's `EnterpriseTelemetrySpool` and `drain_org`)
- Create: `packages/tacho/src/trace/project.ts` (tacho → `TraceEvent` NDJSON), `src/trace/oracles.ts` (TypeScript port of the eight checks), `src/trace/report.ts`
- Create: `packages/tacho/fixtures/contextgraph-trace/` (`golden.ndjson`, `golden-resume.ndjson`, `trip-*.ndjson`, `manifest.json` with upstream commit and per-file sha256)
- Create: `packages/tacho/schema/tacho-1.0.schema.json`, `packages/tacho/schema/contextgraph-trace-0.1-sketch.schema.json` (the trace envelope has no upstream JSON Schema; this is the first, and is offered upstream)
- Create: `tools/scripts/check-tacho-fixtures.ts`; wire into `pnpm gate` beside `check-contextgraph-fixtures.ts`
- Create: `packages/tacho/README.md`

- [ ] Write the envelope schema test first from `design/trace-model.md` §1 plus the harness kinds; expect failure until the schema exists.
- [ ] Implement the envelope, digest, chain (`hash = sha256(JCS(event ∖ hash))`, genesis `prev_hash = sha256("")`), and the timestamp profile guard.
- [ ] Implement the WAL and spool with tests for: dense seq under concurrent emitters, crash between append and ack (re-send lands on the same `event_id_idem`), full buffer (`telemetry_gap` chained with count and duration), poison row quarantine.
- [ ] Copy the trace fixtures from `context-graph-protocol@<pinned>` `contextgraph-trace/fixtures/`; write `manifest.json`; write the drift gate.
- [ ] Port the eight oracles; test that `golden*.ndjson` pass all and each `trip-<check>.ndjson` fails exactly `<check>` with evidence naming the same `seq` values the upstream Rust suite names.
- [ ] Implement `project.ts` per `spec.md` §6.4 with a fixture session covering start, two turns, a denied tool, a subagent, a compaction, a crash-resume, and a clean end; assert the projection passes the oracles and that a session with an `unobserved_tail` gap is reported as a crash, not a pass.
- [ ] Run `pnpm --filter @oxagen/tacho test`; expect pass. Run `pnpm check:tacho-fixtures`; expect pass.
- [ ] Commit: `feat(tacho): tacho/1.0 envelope, chain, WAL, and contextgraph-trace projection`

## PR 2 — Control-plane capabilities and storage

**Files:**

- Create: `packages/oxagen/src/contracts/tacho.host.enroll.ts` (`create_tacho_host_enrollment`), `tacho.host.revoke.ts`, `tacho.events.ingest.ts` (`ingest_tacho_events`, `noBillingGate: true`, API-key only), `tacho.policy.bundle.get.ts` (`get_tacho_policy_bundle`), `tacho.elevation.request.ts` (`request_tacho_elevation`), `tacho.session.control.ts` (`control_tacho_session`), `tacho.host.control.ts` (`control_tacho_host`), `tacho.inbox.poll.ts`, `tacho.session.list.ts`, `tacho.session.get.ts`, `tacho.host.list.ts`
- Modify: `packages/oxagen/src/contracts/index.ts`
- Create: `packages/handlers/src/tacho.*.ts`; `packages/handlers/src/lib/tacho-enrollment-signing.ts` (reuse the framing from `stella-enrollment-signing.ts` with the new domain)
- Modify: `packages/handlers/src/api.key.create.ts` (refuse `tacho_host` / `tacho_agent` purposes)
- Create: `apps/api/src/routes/v1/tacho.ingest.ts`, `tacho.policy.ts`, `tacho.inbox.ts` (own sub-router outside the org/workspace path group, API-key auth, `bodyLimit` 1 MiB, strict `Content-Type`, the three-layer rate limits copied from the Stella ingest mount); `apps/api/src/routes/v1/tacho.*.ts` for the session-auth capabilities
- Modify: `apps/api/src/app.ts` (mounts)
- Modify: `packages/database/src/schema/agent.ts` (`tacho_hosts`, `tacho_sessions`, `tacho_control_commands`); create the Atlas migration
- Create: `packages/telemetry/src/migrations/00NN_tacho_events.sql` (`ReplacingMergeTree(received_at) ORDER BY (org_id, workspace_id, event_id_idem)`), `packages/telemetry/src/tacho-events.ts` (insert with tenant stamping; projection into `tool_invocations` and `token_usage`)
- Create: `docs/capabilities/tacho.*.md`; MCP tool and CLI wrappers per the parity stack
- Create: `packages/handlers/fixtures/tacho-enrollment-signature-conformance.v1.json`

- [ ] Write handler tests first: enrollment creates exactly one agent, one principal (`kind: agent`, `parent_user_id` set), one API key with the purpose scope, and returns a signature that verifies against the fixture vector.
- [ ] Write the ingest test: a batch whose events carry another workspace id is rejected in full; an accepted batch stamps the key's scope; a re-sent batch yields the same `event_id_idem` rows; `accepted === event_ids.length`; a batch with a `seq` gap for a known session is accepted and the session marked `gap_observed` (never rejected, per fail-open telemetry).
- [ ] Write the bundle test: the bundle is signed, carries `deny_generation` from `iam.authorization_deny_generations`, and `permissions` compiled from the host principal's grants in Claude Code rule syntax (PR 6 fills the compiler; PR 2 returns the empty-rules bundle in `observe` mode).
- [ ] Implement contracts, handlers, routes, storage, migrations.
- [ ] Ingest response includes `{ deny_generation, bundle_etag, commands: [...] }` for the sessions in the batch.
- [ ] Run `pnpm --filter @oxagen/handlers test -- tacho`, `pnpm --filter @oxagen/api test -- tacho`, `pnpm check:manifest`, `pnpm db:lint-migrations`; expect pass.
- [ ] Commit: `feat(tacho): host enrollment, event ingest, policy bundle, and control capabilities`

## PR 3 — Collector, hook binary, Claude Code adapter, enrollment

**Files:**

- Create: `packages/tacho/src/collector/{server,hook-receiver,otlp-receiver,session-registry,detector,inbox,exporters}.ts`, `src/collector/main.ts` (`tachod`)
- Create: `packages/tacho/src/claude-code/{hook-handler,settings-writer,enrollment,env,service-install}.ts`; `src/claude-code/hook-main.ts` (`tacho-hook`)
- Create: `packages/tacho/src/cli/{enroll,status,unenroll,export,verify}.ts`, `src/cli/main.ts` (`tacho`)
- Create: `packages/tacho/scripts/bundle.mjs`, `scripts/prepare-standalone-publish.mjs` (copy the CLI pipeline; three bins)
- Create: `packages/tacho/test/hook-contract.test.ts` with recorded Claude Code hook payloads for every event in `spec.md` §5.4 at the current Claude Code version, and a version-range guard
- Create: `packages/tacho/test/bench/hook-latency.test.ts`

- [ ] Record real hook payloads from Claude Code 2.1.x for every event, including `agent_id`/`agent_type` on subagent events and the `SessionStart` matchers; commit them as fixtures.
- [ ] Implement `handleHookEvent(input) → output` as a pure function over the collector client; every Claude Code event in §5.4 maps to its Tacho events and its decision shape. Test each fixture.
- [ ] Implement `tacho-hook`: read stdin JSON, connect to the socket with a 50 ms budget, on failure evaluate the cached bundle and append to the spool; exit codes per the Claude Code contract (0 with JSON decision; 2 with reason on deny). Test the daemon-down path denies an out-of-grant tool and spools the event.
- [ ] Implement the hook receiver (`http` hooks, local bearer check) and the OTLP receiver (`/v1/logs`, `/v1/metrics`; `api_request` → `llm_call`; correlate by `session.id` and `prompt.id`).
- [ ] Implement the session registry: genesis on `SessionStart`, transcript-path cross-check, subagent child sessions, seal on `SessionEnd` or process exit, `unobserved_tail` gap.
- [ ] Implement the detector: `claude` process scan and `~/.claude/projects/**/*.jsonl` mtime watch; chain `oxagen:unobserved_session` for activity without a hook stream; re-read settings at each bundle refresh and chain `oxagen:hooks_removed`.
- [ ] Implement the settings writer: merge with marker, idempotent, never removes foreign entries, `env` block for OTel; test against a settings file with pre-existing hooks on the same events.
- [ ] Implement service install for launchd and systemd user units; test with a fake service manager.
- [ ] Implement `enroll`, `status`, `unenroll`, `export` (tacho NDJSON, trace NDJSON, OTLP JSON), `verify` (`claude -p --max-turns 1` probe).
- [ ] Measure: telemetry hook p50 and `tacho-hook` p95 on the reference laptop; record in Verification below. If `tacho-hook` p95 exceeds 30 ms, open the compiled-binary follow-up before GA.
- [ ] Run `pnpm --filter @oxagen/tacho test`; expect pass. Run the standalone bundle and install it on a clean user account; run criteria 1, 2, 3, 9, 18 by hand and paste the output into Verification.
- [ ] Commit: `feat(tacho): tachod collector, tacho-hook, and one-command Claude Code enrollment`

## PR 4 — `oxagen tacho` CLI and docs

**Files:**

- Create: `apps/cli/src/commands/tacho.ts` (delegates to `@oxagen/tacho` functions through the CLI's auth and config plumbing)
- Modify: `apps/cli/src/program.ts`
- Create: `apps/docs/.../tacho/{index,enroll,claude-code,claude-agent-sdk,custom-agents,honesty}.md`
- Delete: `tools/scripts/claude-telemetry-logger.ts`, `backfill-claude-telemetry.ts`, `sync-claude-telemetry.ts`, `setup-claude-code-telemetry.ts`; modify `.claude/settings.json` to drop the dogfood hooks
- Modify: `TELEMETRY.md` (Tacho is not anonymous usage telemetry; link to its own disclosure)

- [ ] Wire the commands; test that `oxagen tacho enroll --token` on a TTY-less shell succeeds and without `--token` fails with the auth message.
- [ ] Show that `internal.claude_sessions` rows for one dogfood day are reproducible from `tacho_events` before deleting the old scripts.
- [ ] Write the docs, including the enforcement-tier honesty page in the words of `spec.md` §1(2).
- [ ] Commit: `feat(cli): oxagen tacho commands; retire the dogfood Claude Code telemetry scripts`

## PR 5 — Claude Agent SDK adapter and custom-agent SDK

**Files:**

- Create: `packages/tacho/src/claude-agent-sdk/{govern,wrap-query}.ts`
- Create: `packages/tacho/src/sdk/{session,wrap,wrap-tool,wrap-model,authorize,inline-emitter,adapters/{vercel-ai,openai-agents,langchain,generic}}.ts`
- Create: `packages/tacho/examples/wrap-vercel-ai.ts` (from `design/examples/typescript/`), `examples/claude-agent-sdk.ts`
- Modify: `packages/oxagen/src/contracts/agent.definition.create.ts` (accept `agent_type` values `claude-agent-sdk`, `custom`, `claude-code`)

- [ ] `govern()` produces `options.hooks` whose callbacks call the same `handleHookEvent`; a test drives the SDK's hook types through both adapters and asserts identical decisions.
- [ ] `wrapTool` checks standing grants, elevates, verifies the token, emits `token_use`, executes, emits `tool_call`; `wrapModel` emits `llm_call`; `wrap` detects the SDK and composes the adapter; unknown objects get the generic proxy.
- [ ] Inline emitter chains and spools in-process when no collector is reachable; checkpoints carry the agent key fingerprint and the session records the wider posterior flag.
- [ ] Run the two examples against a fake control plane in tests; criterion 12 minus enforcement.
- [ ] Commit: `feat(tacho): Claude Agent SDK adapter and custom-agent SDK`

## PR 6 — Authority

**Files:**

- Create: `packages/handlers/src/lib/tacho-bundle-compiler.ts` (IAM grants → Claude Code rules; tool declarations → risk grades; budget policy → ceilings)
- Create: `packages/handlers/src/lib/tacho-mint.ts` (Biscuit v2 authority block per `design/approval-tokens.md` §3; Ed25519 keys via KMS-backed key versions; CRL)
- Modify: `packages/handlers/src/tacho.elevation.request.ts` (`authorizeExternalCapability("claude.<tool>")` → allow / require_approval → `createApprovalRequest` + `waitForApproval` → mint)
- Modify: `packages/tacho/src/claude-code/hook-handler.ts` (standing-grant evaluation, staleness on deny generation, elevation on `PermissionRequest`, token verification with `biscuit-auth` wasm)
- Modify: `packages/tacho/src/collector/inbox.ts` (commands: pause, resume, cancel with SIGTERM by matched pid, message, revoke)
- Modify: `apps/app` approval card to show the four-hop chain for Tacho requests

- [ ] Compiler tests: a role grant with `effect: deny` on `Bash(git push*)` becomes a `deny` rule; a `require_approval` becomes `ask`; `allow` becomes `allow`; deny-generation bump changes the bundle etag.
- [ ] Elevation tests: auto-allow mints a token bound to session, action, expiry 120 s, use limit 1 for destructive verbs; escalation waits on the listener and resolves through `resolve_approval`; timeout returns deny with `reason_code: expired`.
- [ ] Hook tests: stale bundle allows read-only tools only; unreachable control plane on a stale bundle denies non-read-only tools; a replayed token in another session fails verification.
- [ ] Command tests: each command takes effect at the next boundary and is chained with the operator principal; `cancel` records the kill attempt outcome.
- [ ] Emergency deny end-to-end: insert an `iam.emergency_denies` row, observe every enrolled host deny within one ingest interval.
- [ ] Commit: `feat(tacho): policy bundles from IAM, elevation with Biscuit tokens, session and host commands`

## PR 7 — `client_attested` evidence

**Files:**

- Create: `packages/oxagen/src/contracts/run-evidence.ingest.ts` (`ingest_run_evidence`, the capability the foundation's finalization grants already pin), handler, internal-transport exposure per the run-evidence spec
- Create: `packages/handlers/src/lib/tacho-session-envelope.ts` (sealed session → `RunEvidenceEnvelopeV1`; gaps → `StageCoverageV1`; replay grade)
- Modify: `packages/telemetry` and `packages/database` as the run-evidence plan's PR 2B requires, scoped to what `client_attested` needs

- [ ] Land `ingest_run_evidence` for `client_attested` first (the hosted `runner_observed` slice stays on its own plan); the manifest is platform-signed and verifies offline.
- [ ] Seal → envelope → manifest test with a full session, a crashed session, and a session with retention off; assert replay grades `structural` / `structural` with `unobserved_tail` / `structural` respectively, and `content_exact` when retention was on.
- [ ] Commit: `feat(run-evidence): ingest_run_evidence for client_attested Tacho sessions`

## PR 8 — Fleet page and approvals

- [ ] Hosts list (identity, status, bundle version, last seen, unobserved count), sessions list, per-session flight recorder (chain, tool timeline, elevations, gaps, tier badge, replay grade), commands (pause, resume, message, cancel, revoke).
- [ ] `/approvals` queue rendering Tacho requests with the requesting span; depends on the review's Phase 3 extraction.
- [ ] Usability review before merge; screenshots on the PR.
- [ ] Commit: `feat(app): Tacho fleet page and approvals integration`

## PR 9 — Stella native and Codex spike

- [ ] Stella: `docs/spec/tacho-core.md` companion (self-contained, names this spec), `tacho-core` crate consuming the envelope schema, executor integration at `tool.call.requested` / `policy.evaluated` / approval types, enrollment as a second event class on the existing signed document; `stella-serve` sessions labelled `gateway` tier.
- [ ] Codex: one-day spike against `developers.openai.com/codex/hooks`; output is either a §5.4-style mapping table committed to `spec.md` §13 or a note that Codex needs a proxy-fidelity adapter.

## Plan-Set Verification

- [ ] Run `rg -n 'TBD|TODO|FIXME' docs/specs/tacho/`; expect no matches.
- [ ] Every acceptance criterion in `spec.md` §14 appears in the coverage table below with a named test or manual verification.
- [ ] Review every path against `main` immediately before starting each PR; if `main` moved, update the path in the implementation PR rather than substituting a seam silently.

## Acceptance-Criteria Coverage

| Spec criterion | Primary evidence |
|---|---|
| 1 one-command enrollment | PR 3 manual run on a clean account, output in Verification |
| 2 all session shapes chained | PR 3 `hook-contract.test.ts` + manual run |
| 3 tool and model events, cost reconciles | PR 3 OTLP receiver tests + `-p` cost comparison |
| 4 deny rule refuses and records | PR 6 hook and decision tests |
| 5 elevation, token, four-hop chain | PR 6 elevation tests + PR 8 UI |
| 6 commands at next boundary | PR 6 command tests + PR 8 |
| 7 emergency deny fleet-wide, fail closed | PR 6 end-to-end |
| 8 hooks removed / unobserved detected; managed prevents | PR 3 detector tests + PR 3 managed-mode manual run |
| 9 daemon down: enforcement holds, telemetry spooled | PR 3 `tacho-hook` daemon-down tests |
| 10 trace journal passes eight oracles; fixtures pinned | PR 1 oracle port and drift gate |
| 11 OTLP renders in a stock collector | PR 3 exporter test against `otel-collector` contrib in CI |
| 12 SDK adapters reach parity | PR 5 example tests |
| 13 tier honesty | PR 2 session record tests + PR 8 string audit |
| 14 client_attested manifests verify | PR 7 |
| 15 tenant never from body | PR 2 ingest tests |
| 16 leaf package, schema parity | PR 1 package test + publish dry run |
| 17 latency budgets | PR 3 bench, numbers below |
| 18 unenroll is clean | PR 3 settings-writer tests + manual run |

## Verification

Filled in as each PR lands. Required entries: enrollment transcript on a clean account (criterion 1), the five session shapes and their chain verification output (2), the `-p` cost reconciliation (3), `tacho-hook` p95 and telemetry hook p50 with machine spec (17), unenroll diff of `~/.claude/settings.json` (18).

## Definition of Done

- [ ] All 18 acceptance criteria in `spec.md` §14 have passing evidence recorded above.
- [ ] `@oxagen/tacho` is published at `latest` with three working bins and no `@oxagen/*` runtime dependency.
- [ ] A session from Claude Code, from a Claude Agent SDK agent, and from the Vercel AI example land in the same tables and render on the same fleet page with correct tiers.
- [ ] The `cgp-website` design folder points here and carries no diverging copy.
