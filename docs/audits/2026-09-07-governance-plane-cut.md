# Adversarial architecture audit — the governance-plane cut

**Date:** 2026-09-07 · **Branch:** `claude/oxagen-architecture-audit-pfgivw` ·
**Baseline:** `9711041769218ab6f8ed2b63b33e77aa5ecd5b83` (main) ·
**Ratified by:** ADR-043 (runtime excision), ADR-042 (tenant data planes)

This is a boundary-and-concept audit, file by file, not a line review. It
answers three questions: (1) is the code organised along seams that will hold
as Oxagen becomes the agent gateway / control plane; (2) what compounds as
debt if it stays; (3) what should be deleted now that Stella is the coding
agent and Oxagen is the governor, grounder, explainer, meter and rater.

## 0. Verdict in five lines

1. **The governance kernel is sound and engine-agnostic.** `invoke()` (IAM →
   billing admission → budget → entitlement → decision rules → tenant scope →
   handler → audit + metering) never imported the runtime. It is the product.
2. **Half the repository was an agent runtime that duplicated Stella**, and it
   was the half accreting fastest. It is deleted in this branch.
3. **The trace/evidence side is under-built relative to its importance.** The
   ledger (`run-ledger`) and CGP conformance (`run-evidence`) exist; the
   `ingest_run_evidence` contract, the trace-level oracle stamp, and the trust
   score do not. That is the next body of work, not this PR.
4. **Rolling back to the RLS baseline (`36660d2db`) would be a mistake.** It
   predates billing→Stripe, IAM principals, authorization snapshots, SOC2
   security events, KMS credentials, reseller rebilling and the ontology
   surfaces — the governance core. Delete forward; do not rewind.
5. **Tenant-switchable data planes need one seam, not a rewrite.** Every store
   is a process singleton today; ADR-042 puts the binding on the organisation
   and routes it through the existing `runInTenantScope` context.

## 1. Where the seams were wrong (compounding debt)

| # | Finding | Why it compounds | Disposition |
|---|---|---|---|
| 1 | **Two registries for one kernel.** `packages/handlers/src/register.ts` and `packages/agent/src/register.ts` both bind handlers into the same kernel; the `agent` one used a `LOADERS` map with a different shape. | Every new capability had two places to forget; `check:manifest` only saw one. | Keep both for now (agent-domain handlers need `@oxagen/agent` runtime types) but the kernel is the only registry; `agent` register mirrors `handlers` shape. Fold into one when `packages/agent` shrinks to the gateway. |
| 2 | **Runtime leaked into the kernel package.** `@oxagen/oxagen` depended on `@oxagen/sandbox` (path validators inside contracts) and `@oxagen/agent-artifacts` (lifecycle event enum in `types.ts`). | The lowest layer imported the highest; every consumer of the kernel pulled Docker/Modal types. | Deleted. `LifecycleEvent` is an opaque string in the kernel. |
| 3 | **`agent-runner` was 94% ledger, 6% runner, named for the 6%.** `execute-turn.ts` + the Stella sidecar adapter made a Rust engine a child process of a serverless function. | Naming lied about the dependency direction; the sidecar pool needed `node:child_process` in a package `apps/app` bundles. | Renamed `run-ledger`; runner and sidecar deleted. |
| 4 | **Chat was the only home of the governance widgets.** Approval, consent, risk badge, activity timeline lived only inside `components/chat/`. | The crown jewels were coupled to the biggest deletion candidate. | Kept those cards; deleted the coding generative-UI registry (diff, terminal, media, swarm, workflow). A standalone approvals queue is the Phase-3 build. |
| 5 | **Contracts without a governance job.** `browser.*`, `code.*`, `image/video/svg/mermaid/markdown/document.*`, `form.fill`, `archive.create`, `web.*`, `research.swarm.*` were metered tool surfaces with no relation to governing anyone else's agent. | Each cost four surface files (API/MCP/CLI/UI) + docs + e2e; parity checks made deletion look expensive so nobody did it. | Deleted (114 contract files, ~111 registered capabilities). |
| 6 | **Execution state in the schema of record.** `sandbox_sessions`, `file_locks`, `agent_plans`, `subagent_*`, `background_tasks`, `agent_run_checkpoints`, `agent_run_attempt_leases`, `sandbox_templates`, `eval.*`, `workflow.*`, `content.*`, `cms.*`. | Runtime tables under RLS + Atlas made every migration slower and every SOC2 data-map longer. | Dropped (migration `20260907120000_drop_agent_runtime_tables.sql`). |
| 7 | **Env registry as a coding-agent config file.** ~60 `OXAGEN_*` knobs (judge panels, mutation verifiers, ladder rungs, fleet dirs) lived in `packages/config`. | Config for a product that is Stella's, validated on every Oxagen boot. | Pruned with their consumers. |
| 8 | **CLI = a second terminal coding agent (47k lines).** REPL/TUI/agent loop in TypeScript, plus an OpenAI-compatible LLM proxy route in the API so the CLI could run inference through the platform. | Direct competition with Stella, in the wrong language, with its own drift. | CLI reduced to governance ops (auth, budget, cost, trace, lineage, secrets, telemetry, memory, graph). `agent.llm` proxy deleted. |
| 9 | **Three marketing sites** (`apps/web` static, `apps/web2` undeployed Next app, `docs/site`). | Nobody knew which was canonical. | `apps/web2` deleted; `apps/web` stays as the deployed static site. |
| 10 | **Stores are process singletons.** `DATABASE_URL`, `NEO4J_URI`, `CLICKHOUSE_URL` are read once; tenancy is enforced *inside* one instance. | Blocks HIPAA/data-residency/air-gapped deployments — the customers the trust posture is for. | ADR-042: organisation-level data planes, resolved from the tenant scope. First slice in this branch: table, encrypted binding, resolver seam, capabilities. |
| 11 | **Evidence ingress is specced, not registered.** `docs/specs/run-evidence-ingress/spec.md` is Approved; `packages/run-evidence` had zero consumers; `ingest_run_evidence` is not a contract. | The one product surface that replaces the runtime is the one that does not exist yet. | Out of scope for the cut; first item after it (see §5). |

## 2. Disposition by package

| Package | Lines (before → after) | Decision | Reason |
|---|---|---|---|
| `oxagen` (kernel, contracts, IAM resolve, plugins) | 62.6k → 43.7k | **Keep** | The product. 367 → 238 registered contracts (incl. the two new data-plane ones). |
| `iam`, `tenancy`, `compliance`, `telemetry`, `crypto`, `config`, `auth`, `notifications`, `storage` | — | **Keep** | Governance, audit, trust. |
| `billing` (+reseller) | 21.9k | **Keep** | Meter→Stripe loop. `runner_observed` attribution retired; gateway + evidence ingress attribution stays. |
| `plugins` (entitlements, credentials/KMS, OAuth, MCP registry) | 11.8k | **Keep** | The governed tool gateway's install and credential plane. |
| `ontology`, `ingestion`, `engram`, `github` (App + repo observation) | — | **Keep** | Graph grounding, memory, knowledge sources. GitHub mutation half deleted. |
| `run-ledger` (was `agent-runner`) | 15.6k → 8.7k | **Keep, renamed** | Evidence ledger: runs, attempts, events, seals, finalization grants. |
| `run-evidence` | 3.2k | **Keep, promote** | CGP conformance + RFC-8785 digests; becomes the spine of ingress. |
| `rules` | 1.4k | **Keep** | Decision rules gate in the kernel — the "refund rules" page. |
| `agent` | 44.9k → 25.7k | **Keep, slimmed** | Governed tool materialisation (IAM → entitlement → RBAC → consent → approval → telemetry per call), agent registry handlers, memory, MCP. Sandbox/subagent/plan/skill/browser/code handlers deleted. |
| `handlers` | 86.6k → 64.0k | **Keep, slimmed** | Foundation handlers minus deleted families. |
| `inngest-functions` | 25.2k → 13.7k | **Keep, slimmed** | Execution functions deleted; billing/ingestion/privacy/security/plugin/schema stay. |
| `ui`, `mcp-config`, `functions` | — | **Keep** | |
| `agent-engine` | 28.7k | **Delete** | Stella's coding loop, in TypeScript. |
| `agent-worker` | 4.3k | **Delete** | The durable runner. |
| `sandbox` | 4.7k | **Delete** | Docker/Modal/Vercel drivers. |
| `skills`, `agent-artifacts` | 2.1k | **Delete** | Skills/agent TOML artifacts are Stella's. |
| `stella-engine-client` | 2.1k | **Delete** | Sidecar transport; Oxagen is not Stella's host process. |
| `web` (Tavily) | 0.8k | **Delete** | Agent tool. |
| `apps/web2` | 4.4k | **Delete** | Undeployed duplicate site. |
| `apps/cli` | 47.6k → 15.4k | **Slim** | Governance ops only. |
| `apps/api` (38.9k → 25.6k), `apps/mcp` (17.4k → 12.2k), `apps/app` (282k → 205k), `apps/docs`, `apps/web` | — | **Keep, slimmed** | Surfaces of surviving contracts. |
| `apps/schemas` | 0.2k | **Delete** | Hosted only the deleted CLI's settings JSON schema. |

## 3. Disposition by contract family (registered capabilities)

**Deleted** (with API route, MCP tool, CLI command, handler, docs page, e2e):
`a2a.card.get`, `agent.background_task.*`, `agent.code.execute`, `agent.compose`,
`agent.feature.verify`, `agent.file_lock.*`, `agent.plan.*`, `agent.repo.edit`,
`agent.sandbox*`, `sandbox.template.*`, `agent.skill.*`, `skill.*`,
`agent.subagent*`, `agent.ui.render`, `archive.create`, `automation.*`,
`browser.*`, `code.*`, `document.*`, `eval.*`, `form.fill`, `image.*`,
`markdown.generate`, `mermaid.generate`, `research.swarm.*`, `svg.generate`,
`video.generate`, `web.fetch`, `web.search`, `workflow.*`,
`repo.{create,fork,file.put,pr.open,branch.create}`.

**Kept — mapped to the five jobs:**

| Job | Families |
|---|---|
| Govern | `agent.approval.resolve`, `agent.role.*`, `agent.definition.*`, `agent.deploy`, `agent.environment.*`, `agent.mcp.*`, `agent.mcp_consent.*`, `tool.declaration.*`, `iam.role.list`, `org.*`, `workspace.*`, `budget.policy.*`, `workspace.budget_policy.*`, `router.*` (BYOK model routing policy), `secret.*`, `environment.*`, `plugin.*`, `api.key.*`, `prompt.settings.*`, `capability.registry.*` |
| Ground | `graph.*`, `ontology.*`, `schema.*`, `connection.*`, `integration.*`, `agent.memory*`, `context.record.*`, `reference.*`, `repo.{configure,sync,pause,resume,metrics,branch.list,ci.status,pr.get,pr.diff}` |
| Explain | `audit.log.query`, `agent.execution.list`, `agent.execution.record`, `agent.trace.get`, `agent.debug.trace`, `lineage.query`, `telemetry.error.cluster`, `chat.message.execution`, `conversation.*`, `chat.message.send` (the in-app agent) |
| Meter / bill | `billing.*`, `billing.reseller_*`, `telemetry.stella.enroll`, `telemetry.stella.ingest` |
| Rate | (none yet — see §5) |
| Platform | `user.*`, `notification.*`, `privacy.*`, `asset.upload`, `command.menu.*`, `model.capability.list`, `system.install.instructions` |

## 4. Schema disposition

Dropped: `agent.{skills,skill_versions,background_tasks,subagent_fanouts,subagent_runs,sandbox_sessions,agent_plans,file_locks,file_lock_fences,agent_run_checkpoints,agent_run_attempt_leases}`,
`environments.{sandbox_templates,sandbox_template_tools}`, `eval.*`, `workflow.*`,
`content.*`, `cms.*`, `ai.batch_jobs`, `ingestion.governed_repository_selections`.

Kept as the trace of record: `agent.{agents,agent_versions,approval_requests,agent_executions,agent_execution_steps,agent_tool_calls,agent_runs,agent_run_events,agent_run_attempts,agent_run_attempt_seals,agent_run_finalization_grants,agent_run_finalization_obligations,tools,tool_versions,context_records,context_record_versions,context_promotions}`,
`iam.*` (principals, roles, grants, access requests, authorization snapshots/decisions, deny generations, emergency denies), `security.*`, `evidence.*`, `billing.*`, `mcp.*`, `plugin.*`, `ingestion.*`, `schema_registry.*`, `privacy.*`, `auth.*`, `org.*`, `workspace.*`, `chat.*`, `notification.*`, `ratelimit.*`, `ai.response_cache`.

ClickHouse: `sandbox_log_events`, `skill_loads`, `eval_item_results`, `eval_results`, `eval_runs`, `claude_sessions`, `session_recaps`, `dev_logs` have no writer after the cut. ClickHouse tables are append-only and cheap; they are left in place and listed here so the next telemetry migration drops them (never drop analytics tables in the same PR as the writers — keep one release of read access for exports).

## 5. What is missing for the stated goal (and is NOT in this PR)

The user-stated target: RBAC at the tool level, real IAM identities for agents,
trust gates with an earned performance rating, trace-level tool-call I/O with
a witness-protocol pass/fail stamp, SOC2/HIPAA-grade posture, easy wrapping
SDKs, tenant-switchable stores.

| Need | State today | Next |
|---|---|---|
| Tool-level RBAC | **Exists.** Contract `defaultRoles` + IAM resolve + `mcp-rbac.ts` + `tool.declaration.*`; `authorizeExternalCapability()` governs synthetic `mcp.<server>.<tool>` ids. | Surface it in the observatory per agent (effective-scope panel exists). |
| Agent IAM identity | **Exists.** `iam.principals` with `kind=agent`, ADR-024 `agentKey`, dual-principal delegation ceiling, authorization snapshots. | Extend registration to third-party agents (enrol / version-bind / revoke). |
| Trust gates | **Partial.** Approval gate (`pending_approval`), decision rules, budget ceilings, emergency denies. | Add a `trust_score` on `agent_versions` fed by graded evidence; gate `requiresApproval` on it. |
| Trace-level tool I/O | **Partial.** `agent_tool_calls` + ClickHouse `tool_invocations` for gateway calls; Stella's drain is content-free today (`docs/specs/tacho/oxagen-trace-drain.md` §1). | Build the content-bearing, consent-gated drain (tacho) + `ingest_run_evidence`. |
| Witness stamp | **Missing.** Stella's flip oracle produces the verdict locally (`witness-protocol.md`); nothing carries it to Oxagen. | Add `verification` receipt to the evidence envelope; stamp `oracle_verdict` on `agent_executions`. |
| Performance rating | **Missing.** | Derive from oracle verdicts + productive ratio (`step-grading-and-productive-ratio.md`). |
| Wrapper SDK | **Missing** (server side half-exists: enrollment keys, operational ingest). | TypeScript SDK speaking the evidence envelope + CGP frames + approval API. |
| Tenant data planes | **Missing.** | ADR-042 first slice in this branch. |
| Encryption at rest | **Partial.** KMS envelope for credentials/billing/ingestion; Postgres/Neo4j/ClickHouse rely on provider disk encryption. | Document per-store posture in `docs/compliance`; per-plane KMS keys ride ADR-042. |

## 6. Outcome

| Metric | Before | After |
|---|---|---|
| TypeScript lines (apps + packages) | ~800k | ~568k |
| Packages | 36 | 27 |
| Apps | 8 | 6 |
| Registered contracts | 367 | 238 |
| Postgres tables | 138 | 107 (+1 `org.data_planes`) |
| Env registry keys | 193 | 93 |
| CLI command modules | 40 | 18 |
| Root-level Inngest functions | 47 | 26 |

`apps/app` remains the largest surface (205k lines); the chat components and
knowledge explorer dominate it. The next cut candidate is the chat transcript
UI once the standalone approvals queue exists (ADR-040 Phase 3).

## 7. How the cut was verified

- Every package typechecks (`tsc --noEmit`) — see the PR checklist.
- `pnpm check:contracts`, `pnpm check:manifest`, `pnpm check:ui-parity`,
  `pnpm env:check`, `pnpm db:lint-migrations` — see the PR checklist.
- Narrow unit tests for each touched file (never the full suite; CI runs it).
- Artifacts under `verifications/session_01R1rEhwUGi1z1ob1v4jbtax/`.
