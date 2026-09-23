# Adversarial review of the Mission Control gap inventory

| | |
|---|---|
| **Status** | Review |
| **Date** | 2026-09-19 |
| **Reviewed** | `oxagen-roadmap:docs/oxagen/mission-control/GAP-INVENTORY.md`, committed at `3985213` (PR #3386, 2026-09-18 19:19 PDT) |
| **Read against** | `origin/main` at `cc8f0b8` (2026-09-19) |
| **Method** | Six reviewers, each told to refute rather than confirm. Five took one page cluster each and checked every row against `apps/app/src`, `apps/app/capability-ui-map.json`, `packages/oxagen/src/contracts`, and `packages/handlers/src/register.ts`. The sixth attacked the framing: target set, cut list, issue references, priorities, scorecard, and method. A seventh mapped backend readiness for every capability the gaps touch. No suite was run. |
| **Follow-on** | `oxagen-roadmap:docs/oxagen/mission-control/BUILD-CHUNKS.md` carries the corrected gap list as six build sessions |

## Verdict

The inventory was mostly right on the day it was written and is wrong in the places that matter most for a build plan.

- **Stale, not wrong.** Five PRs landed on 2026-09-19 after the audit's commit: #3385 (mandate detail page), #3352 (Run chain and seal, fork, bisect, the Run approvals tab), #3467 (resolved approvals), #3271 (Spend pricing tab), and #3392 (Stripe Checkout restored). Nine rows the audit marks Missing are Built at head.
- **Wrong at its own commit.** The audit says the loopback model proxy, the enforced session budget, and a real interrupt do not exist. They were on `main` the day before the audit. It says the approval chain contract is thin. All four hops were in the schema before the audit landed. It says nothing lists a workspace's connections. Three connection capabilities are registered.
- **Unverifiable target.** The audit's target set is "canonical §14" in a roadmap repository this tree cannot reach, and it calls the local spec "not the source of truth". Every cut it cites is recorded in this repo, in `apps/app/ARCHITECTURE.md` §9, which the audit never cites for them.
- **Priorities off by phase.** Proof and definition of done (P0 in the audit) follow Phase 5, the last phase in the 2026-09-18 build order, and carry `needs:decision` and `needs:rig`. The enforcement tier column, which the audit ranks P1, is a one-column add over data already on every row and is the cheapest honesty item on the list while Phase 4 changes what `gateway` means.
- **Scorecard not reproducible.** No weighting is stated. On the audit's own rows Fleet is 38 percent, not 55. Tools is 38, not 50. Agents is 58, not 70. Organization is 69, not 80. Approvals is 10, not 20.

## 1. Rows refuted or stale at head

Ranked by how far they would mislead a build plan.

| # | Audit row | Audit says | What the code says | Evidence |
|---|---|---|---|---|
| 1 | Cross-cutting: loopback model proxy and MCP aggregator | Phase 4, none exists, no gateway-tier halt, budget, or injection | The proxy is on `main`: Anthropic and OpenAI passthrough with streaming, enforced `session_limit_usd`, paused and cancelled sessions refused with in-flight requests aborted, enrollment writes the base URLs, and the `gateway` tier is computed from routed traffic. Per-turn injection is the one seam still waiting on Phase 1 | `packages/tacho/src/collector/model-proxy.ts:30-60,152-161,467-474,638-678`, `model-proxy-listener.ts`, `host/model-base-url.ts`, `packages/handlers/src/tacho.events.ingest.ts:584-592`; commits c3e8dc7, dacf3fa, 5a89a41, 7564691 |
| 2 | Run: chain and seal tab | Missing | Built with a test and a binding | `features/run/run.tsx:44,218-221`, `features/run/chain.tsx`, ui-map `get_run_chain` |
| 3 | Run: fork replay and bisect | Missing | Built | `features/run/replay-actions.tsx`, `header.tsx:262-264`, ui-map `fork_run`, `bisect_runs` |
| 4 | Run: policy and approvals on this run; Approvals: strip on Run; "approve on Run once the run link works" | Missing (#3286) | The `approvals` tab reads `list_approvals {runId}` and `list_resolved_approvals`. The precondition is met. Only the decision control is missing, and it is one component shared with Fleet | `features/run/run.tsx:223-250`, `resolved-approvals.tsx`, ui-map `list_approvals`, `list_resolved_approvals` |
| 5 | Agents: mandate detail route | Missing (#2957), no route under `src/app` | Built: header, four tiles, searchable ledger, grant panel, reconciliation panel, Change limits and Revoke dialogs | `app/[org]/[ws]/mandates/[mandate]/page.tsx`, `features/mandate/`, ui-map `get_mandate`, `revoke_mandate`, `update_mandate_limits` |
| 6 | Approvals: four-hop chain | Missing, "contract chain is thin" | All four hops are in the `list_approvals` output: `requester`, `chain.agentKey` (slot exists, no writer yet), `tool`, `chain.rule`. The app mapper drops `chain.rule` and `autoEligibility`. A mapper and card change, not contract work | `contracts/agent.approval.list.ts:26-78`, `apps/app/src/data/live/mappers/approvals.ts:13-26` |
| 7 | Organization: set model route | Missing | Cut on 2026-09-14 and recorded. The funding form already writes a per-tier model map. The only live routing contracts are the market-router policy, not a provider route table | `ARCHITECTURE.md:83,1132`, `features/organization/model-funding-form.tsx:50-53,97-119`, `contracts/org.model_credential.set.ts:113-121` |
| 8 | Spend: tab list | Six tabs | Seven. The pricing tab (price book, negotiated rates, unpriced models) shipped in #3271 with four contracts and four bindings | `features/spend/view.ts:16-24`, `pricing.tsx`, `price-dialog.tsx`, `remove-rate-dialog.tsx` |
| 9 | Tools: connections and owners | "no capability lists the workspace's connections" | `list_connections`, `get_connection`, and `create_connection` are registered. A connections table is UI-only. Owner and review columns need a contract field | `contracts/connection.list.ts:5-18`, `register.ts:759-771` |
| 10 | Cross-cutting: records reach a wrapped agent | "may not change Claude Code or Codex until delivery holds" | Phase 0 merged on 2026-09-18. `must` and `should` records ride `context.system` into Claude Code at `SessionStart`. Stella and Cursor adapters consume it. Codex delivery is unasserted, not absent. The open item is the proof on #2592 | `packages/handlers/src/lib/tacho-steering.ts`, `packages/tacho/src/collector/hook-handler.ts:398-455`, ADR-091 |
| 11 | Skills: fold under Steering, redirect `/skills` | Missing (Phase 2) | Implemented on open PR #3479 (`mc/creation-wizards`) with `propose_skill` and the creation wizards. A merge, not a build | `origin/mc/creation-wizards:apps/app/src/features/steering/view.ts:16` |
| 12 | Run: tabs in code | transcript, frames, cost | Five tabs | `features/run/run.tsx:44` |
| 13 | Skills: five-tab target | Missing against ADR-090 | ADR-097 amended ADR-090. Skills is a tab of Steering with different content (spec §10.7). The audit grades the page against a dead target, and `ARCHITECTURE.md` §1.2 lines 80 and 90 describe a `[[...tab]]` route that does not exist | `docs/adr/ADR-097:108,119,129`, `spec.md:1184` |
| 14 | Audit: incidents | Missing | `list_incidents` is live and bound to Agents. An org-scope register is new backend because the handler filters on `ctx.workspaceId` | `ARCHITECTURE.md:88`, ui-map `list_incidents` |
| 15 | Spend: reconciliation | Cut, attributed to the roadmap | Cut and recorded here in ADR-062. The `get_reconcile_status` contract is a schema reconcile poller, not spend | `docs/adr/ADR-062:10,20,34-40` |
| 16 | Data plane UI | Missing, "effectively cut" | Cut and recorded | `ARCHITECTURE.md:83,1132` |

## 2. Rows confirmed, with the sizing the audit left out

The build plan needs to know whether a gap is UI-only over a live handler or needs backend. The audit does not say. This table does.

| Gap | Backend today | Class |
|---|---|---|
| Approve and deny with reason (Fleet panel, Run tab) | `resolve_approval` registered, API and MCP routes, `kernelWrite` seam already tested in `server/kernel.test.ts`. No `app` layer, no binding | UI-only. Add `app` layer, binding, proof. #2950 decision 1 ratifies it as the billed governed action |
| Auto-approval eligibility line on cards | `list_approvals.autoEligibility` returned, dropped by the mapper. `get_auto_eligibility` registered | UI-only |
| Fleet enforcement tier column | `RunRow.enforcementTier` already on the view model. Run draws it | UI-only, one column |
| Fleet verdict column | `list_runs.verdict` returned, dropped by the app mapper | UI-only, mapper plus column. Renders "not recorded" until proof frames exist |
| Fleet pause, resume, cancel | `dispatch_command` with `target.kind` run, agent, or workspace. Handler refuses ledger and observe runs | UI-only for tacho runs |
| Steer with a delivery mode | `dispatch_command.payload.requestedMode` exists. The action sends none | UI-only, a picker |
| Tools auto-approval rules tab | `set_approval_rules`, `list_approval_rules`, `delete_approval_rule`, `set_approval_rule_enabled`, `get_auto_eligibility` all registered. None has a `docs/capabilities` file though each declares the `docs` layer | UI-only plus five doc files |
| Grant a mandate (Tools ledger, Agent mandates tab) | `grant_mandate` registered, Owner and Admin, `requiresApproval` | UI-only |
| Assign and revoke an agent role | `assign_agent_role`, `revoke_agent_role` registered | UI-only |
| Revoke enrollment as a UI write | `revoke_tacho_enrollment` registered, surfaces `["api"]` only | UI-only plus `app` layer |
| Connections table and add connection | `list_connections`, `get_connection`, `create_connection` registered | UI-only. Owner and review date need a contract field |
| Servers in the registry, import server | `list_mcp_servers`, `register_mcp_server` registered, unbound | UI-only |
| Send an invitation | `send_workspace_invite` registered. Its handler records an organization invitation with an org role and no workspace, and a repeat for a pending email returns the existing invitation | UI-only. An organization invitation with no workspace picker; the scoped contract takes a workspace as invocation scope only |
| Proof tab on Run | `get_run_proof` registered, surfaces `["api"]` | UI-only for the tab. Certificate, checks, Stops, and signing a human check have no contract and follow Phase 5 |
| Run export download | `export_run` returns `{exportId, status}`. Nothing reads `evidence.run_exports` back. `get_export_status` is the privacy export, not runs | Backend: a status read and a download route (#2952) |
| Toolbelt input schemas | `get_agent_toolbelt` output has no schema field | Contract change plus UI |
| Set budget on the agent | `set_spend_budget` scopes are org and workspace only | Backend plus UI, needs an ADR on agent-scope budgets |
| Steering Memory tab | `list_memories`, `delete_memory`, `demote_memory` registered from the agent package | UI-only |
| Steering Policy tab | `list_mandates`, `list_approval_rules`, `list_kill_switches` registered. Gate notice compilation is Phase 1 | UI-only for the lists |
| Steering Preview | `assembleSteering` has no source hit | Backend, Phase 1 (#3296) |
| Skills tab content per §10.7 | No skills table, loader, or sync | Backend, Phase 2 |
| Ontology notes tab | No contract | Backend, Phase 2 |
| Spend provider key and task dimensions | `get_spend` has no such group | Backend plus UI |
| Audit incidents, org scope | Handler filters on workspace | Backend plus UI |
| Audit receipts | No store, no contract | Backend, store, needs a decision |
| Audit retention panel | `get_evidence_retention` read exists, no write | UI-only for a read panel |
| Ledger halt token (WL-61) | 20 of 24 worklist paths are outside the app. The disabled state renders the decided, honest copy | Backend (#2953). Not a UI defect |

## 3. What the audit missed

- **Pages in code the target set omits.** Mandate detail, Register, Agent source, Roles, API keys, Model funding, the workspace Repositories dialog (eight bindings, PR #3326), the Account dialog (five bindings), `/cli/authorize`, `/invite/[token]`, and `/new-organization`. Open PR #3459 adds a Repositories page. The plan must say whether it is a tenth page.
- **The steering freshness panel** (PR #3276): repository, published commit, version, and the `autoSync` and `blockStaleRuns` gates. A whole built section with no row, and the one reverse parity defect found: `get_steering_freshness` is invoked by the page but declares no `app` layer and has no binding.
- **Spec §14 actions with no row.** Run: steer with a delivery mode, tool calls with their validation results, policy decisions. Agents: rotate credential (built), suspend and resume (built), revoke role, budgets shown on the agent. Tools: import server, add connection, schemas in the registry. Steering: add a skill, retire a memory, preview.
- **Run approvals cards on Run pass an empty mandates map** (`run.tsx:240`), so a card on Run names the mandate where Fleet draws the bar.
- **The Fleet "waiting on a human" tile counts one page** (`PAGE_SIZE = 100` in `data/live/approvals.ts:16`).
- **Gateway outcomes have no view.** The proxy seals `llm_call` frames, `policy_decision` refusals, and observed metering. No Fleet or Run row asks whether a budget refusal, a routed tier, or an interrupt outcome is shown.
- **Owning issues never cited.** #2950 (P0, owns approve and deny plus the tier and verdict columns), #2953 (run controls), #2952 (export download), #2962 and #2964 (Spend and Organization lanes still open), #2592 (Phase 0 proof), #3304 (Codex and Stella runs absent from totals, with a stated DoD for a caveat beside every total), #3395 (no route renders one published record).
- **The ceremony freeze.** ADR-091 §6 freezes new governance ceremony until #2592 records a merged record seen in a real run. Any Steering item that adds a proposal state or review step is blocked by policy, not by code.
- **Two integrity defects under Built rows.** The `get_contract_rate` binding's proof points at `features/billing/contract-rate.test.tsx`, which does not exist, and `check_ui_parity.mjs:236` only checks that the proof string is non-empty. Twelve contracts declare a `docs` layer with no `docs/capabilities` file (five approval rule contracts, six mandate contracts, `get_steering_freshness`).

## 4. Framing

**Target set.** Four sources, four page sets. The code and `ARCHITECTURE.md` §1.2 agree route for route. The local spec §14 defers to `ARCHITECTURE.md` in its first sentence. CLAUDE.md says the code establishes what ships. The plan takes the page set from `apps/app/src/app/` with `ARCHITECTURE.md` §1.2 as the map, and treats Skills as in scope until #3297.

**Cut list.** All ten cuts are recorded in `ARCHITECTURE.md` §9 (entries of 2026-09-14 and 2026-09-15), and reconciliation also in ADR-062. Two reversals the audit does not carry are there too: Audit page (reversed 2026-09-15, #3097) and Model funding (reversed 2026-09-18). None of the cuts has an ADR, and spec §2.1 still lists legal hold, reconciliation, and the ontology engine in scope. SCR-002 wants the decision in an ADR.

**Issue references.** #2957 and #3286 are false at head. #3098 is misread: its body is inventory-only and lists the five tabs as out of scope. #2955 is P3 with `needs:decision` and `needs:rig`, not a P0.

**Priorities.** P0-1 (approve and deny) stands and is #2950's. P0-2 (proof and DoD) follows Phase 5. P0-3 (WL-61) is a backend lane over an honest disabled state. The under-ranked P0 is the tier column with #3285: ADR-095 says the vocabulary rule applies now, and #3299 changes what `gateway` means when it merges.

**Scorecard.** Built one, Partial half, Missing zero, Cut excluded:

| Page | Recomputed on the audit's rows | Audit | At head |
|---|---|---|---|
| Billing | 100 | 95 | 100 |
| Spend | 81 | 85 | higher, pricing shipped |
| Organization | 69 (79 with data plane as cut) | 80 | 79 |
| Agents | 58 | 70 | 67 |
| Run | 43 | 45 | 63 |
| Audit | 40 | 40 | 40 |
| Fleet | 38 | 55 | 38 |
| Tools | 38 | 50 | 38 |
| Steering | 38 | 35 | 38 |
| Skills | 25 | 15 | 25 |
| Approvals | 10 | 20 | 30 |

## 5. Corrections the build plan carries

1. Re-baseline on head `cc8f0b8`. Strike the nine stale Missing rows.
2. Page set from the code with `ARCHITECTURE.md` §1.2 as the map. Skills stays in scope until #3297.
3. Promote the Fleet tier column, with #3285, to the first session beside approve and deny.
4. Attribute approve and deny to #2950 and record decision 1 in an ADR in the same PR.
5. Move proof and DoD out of P0. Build the Proof tab over `get_run_proof` and the verdict column now. The rest waits on Phase 5 and #2955's decisions.
6. Reclassify WL-61 as backend under #2953.
7. Cite `ARCHITECTURE.md` §9 for every cut. File one ADR recording the 2026-09-14 scope review and fix spec §2.1.
8. Rank the Skills surface as Phase 2 work behind #3479's merge, not P1.
9. Merge #3479 and #3459 before building Steering or Repositories.
10. Add `capability-ui-map.json` to the method. It contradicted five Missing rows.
11. Fix the two integrity defects: the dangling proof, and `check_ui_parity` verifying that a proof path exists.

## What was not verified

No test, build, lint, or typecheck ran. Issue states came from the GitHub API on 2026-09-19. The roadmap repository was not read. Whether Codex receives `additionalContext` at `SessionStart` is unasserted in code and was not tested.
