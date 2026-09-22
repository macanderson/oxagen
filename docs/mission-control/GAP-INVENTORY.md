# Mission Control: page-by-page gap inventory

| | |
|---|---|
| **Status** | Snapshot |
| **Date** | 2026-09-19, Fleet and Agents rows re-verified 2026-09-21 against `origin/main` after #3516, #3705 and #3708 |
| **Spec** | Canonical: `docs/mission-control-spec.md` in https://github.com/macanderson/roadmap (§14, after the 2026-09-14 scope review and the 2026-09-18 steering review). Local copy `docs/specs/mission-control/spec.md` still diverges on page count and is not the source of truth here. |
| **Code** | `apps/app` on oxagen `main` as of this document's commit |
| **Method** | Spec §14 primary actions and tabs, checked against routes under `apps/app/src/app/[org]/`, feature modules under `apps/app/src/features/`, and `src/data/unrecorded.ts` |

Legend: **Built** · **Partial** · **Missing** · **Cut** (scope review: do not build).

The only remaining catalog `UNRECORDED` row is `run.frames_wrapped` (G6). Every other whole-page NotRecorded row is gone.

---

## Target set (canonical §14)

Nine pages: Fleet, Run, Agents, Tools, Steering, Spend, Organization, Billing, Audit. Approvals are a panel on Fleet and a strip on Run, not a page. Skills and Ontology have no top-level nav in the Phase 2 target; they become Steering tabs. The live app still ships Skills as a sidebar page.

---

## 1. Fleet (`/{org}/{ws}`)

Feature: `apps/app/src/features/fleet/`. Reads: `list_runs`, `list_approvals`, `get_spend` (tiles).

| Spec item | Status | Evidence |
|---|---|---|
| Live and recent runs table | **Built** | `runs-table.tsx`; open links to Run |
| Replay grade, cost, frames | **Partial** | Columns present; values often "not recorded" |
| Enforcement tier | **Built** | #3705; `EnforcementTierBadge` column between Status and Cost |
| Verdict / definition-of-done state | **Missing** | No DoD column or held tile |
| Pending approvals queue | **Built** | #3516; `approval-decision.tsx` dialog calls `resolveApprovalAction` |
| Spend today and cache hit tiles | **Built** | `features/spend/fleet-tiles.tsx` |
| Pause / resume / cancel from Fleet | **Built** | #3516; `run-row-controls.tsx` calls `dispatch_command` per row |
| Approve / deny from the queue | **Built** | #3516; a denial requires a non-empty note, enforced server-side |

---

## 2. Run (`/{org}/{ws}/runs/[run]`)

Feature: `apps/app/src/features/run/`. Tabs in code: `transcript` \| `frames` \| `cost` only (`run.tsx`).

| Spec item | Status | Evidence |
|---|---|---|
| Transcript at three zoom levels | **Built** | turns / steps / everything |
| Transport player | **Built** | `transcript-view.tsx` |
| Frames tab | **Partial** | Ledger frames work; wrapped runs hit `run.frames_wrapped` |
| Cost tab and header cost | **Built** | |
| Header: status, replay grade, sealed | **Built** | `header.tsx` |
| Pause / resume / steer / cancel | **Partial** | Live tacho only; ledger controls disabled (no revocable run token) |
| Summarize | **Built** | Sealed runs via `summarize_run` |
| Export | **Built** | `export_run` queues the bundle. `get_run_export` (API, MCP, CLI, Run page) reads its status and mints a 15-minute download URL that needs no session. `oxagen verify <bundle>` checks it offline, held or broken per frame. Guide: `docs/guides/export-and-verify.md` |
| Approve / deny on this run | **Built** | #3516; `run.tsx` renders the same `ApprovalsPanel` as Fleet plus `ResolvedApprovalsPanel` for decided ones |
| Policy on this run (rules, versions) | **Missing** | Deferred (#3286) |
| Proof / witness | **Missing** | #2955 |
| Chain / seal tab | **Missing** | Replay grade stays in the header |
| Definition of done (verdict, certificate, checks, Stops) | **Missing** | |
| Sign a human check | **Missing** | |
| Fork replay / bisect | **Missing** | |

---

## 3. Approvals (panel, not a page)

| Spec item | Status | Evidence |
|---|---|---|
| Queue on Fleet | **Built** | #3516; the decision dialog, not cards alone |
| Strip or panel on Run | **Built** | #3516; the same `ApprovalsPanel`, `on="run"` |
| Four-hop chain UI | **Missing** | Contract chain is thin; UI shows agent key |
| Approve / deny with reason | **Built** | #3516; a denial's note is required server-side, not only by the form |
| Auto-approval eligibility line | **Built** | #3516; `Eligibility` reads `get_auto_eligibility` and re-checks on open |

---

## 4. Agents (`/{org}/{ws}/agents`)

Routes: list, `agents/[agent]`, `agents/[agent]/source`, `register/[step]`. Feature: `apps/app/src/features/agents/`.

Detail tabs today: identity \| toolbelt \| enrollment \| incidents \| definition \| mandates.

| Spec item | Status | Evidence |
|---|---|---|
| Identities list | **Built** | |
| Identity, roles, credentials | **Built** | |
| Toolbelt with decision rules | **Partial** | Rules shown; no input schemas |
| Mandates tab and request | **Built** | `request_mandate` |
| Enrollment status | **Partial** | Host table is read-only; enroll via CLI or register wrap |
| Tamper / incidents | **Built** | |
| Register flow | **Built** | name → wrap → run |
| Definition source editor | **Built** | TOML + `commit_agent_definition` |
| Kill switch (stop this agent) | **Built** | #3708; `set_kill_switch` on the agent plus a `dispatch_command` pause broadcast to its live runs |
| Mandate detail `…/mandates/{mandate}` | **Missing** | #2957; no route under `src/app` |
| Grant role / grant mandate UI | **Missing** | Request only |
| Set budget on the agent | **Missing** | Budgets live on Spend |
| Revoke enrollment as a UI write | **Missing** | Side effect of retire |
| Agent scores / percentiles | **Cut** | |

---

## 5. Tools (`/{org}/{ws}/tools`)

Feature: `apps/app/src/features/tools/`. Tabs: `registry` \| `connections` \| `switches` \| `mandates` (`view.ts`). Mockup has six; Policy and Auto-approvals are not in `TOOLS_TABS`.

| Spec item | Status | Evidence |
|---|---|---|
| Registry (versions, safety, import) | **Partial** | Versions, classify, import tools; no server catalog UI |
| Approve observed schema | **Missing** | |
| Connections and owners | **Missing** | Connections tab is the credential-grants log |
| Credential grants | **Built** | |
| Mandates ledger | **Partial** | Read-only; no grant from Tools |
| Kill switches and flip | **Built** | `set_kill_switch` |
| Policy versions and tests | **Missing** | Tab not shipped |
| Auto-approval rules | **Missing** | #2970 |
| Policy simulation | **Cut** | |
| Assurance suite | **Cut** | |

Writes wired today: `import_tools`, `set_tool_classification`, `set_kill_switch`.

---

## 6. Steering (`/{org}/{ws}/steering`)

Feature: `apps/app/src/features/steering/`. Tabs: `records` \| `proposals` \| `prs`.

| Spec item | Status | Evidence |
|---|---|---|
| Records | **Built** | `list_records` |
| Proposals | **Built** | dismiss |
| Context PRs | **Built** | open / merge |
| Skills tab | **Missing** | Phase 2 hub |
| Memory tab | **Missing** | Phase 2 |
| Ontology tab (notes, not the engine) | **Missing** | Phase 2 |
| Policy tab | **Missing** | Phase 2 |
| Preview (`assembleSteering`) | **Missing** | Phases 1 and 2 |
| Effect / retirement / thresholds | **Cut** | |

---

## 7. Skills (`/{org}/{ws}/skills`) (extra vs the nine-page target)

Feature: `apps/app/src/features/skills/`. Still in `WORKSPACE_NAV`. One inventory section; no catch-all tabs in code.

| Spec item | Status | Evidence |
|---|---|---|
| Observed inventory (`list_skills`) | **Built** | Harness-reported names only |
| Catalog / Search / In the loop / Reflection / Versions | **Missing** | ADR-090 / #3098; `ARCHITECTURE.md` §1.2 describes them, the page does not |
| Config and digest writes | **Missing** | |
| Fold under Steering; redirect `/skills` | **Missing** | Phase 2 |

---

## 8. Spend (`/{org}/{ws}/spend`)

Feature: `apps/app/src/features/spend/`. Tabs: findings \| operator \| agent \| tool \| waste \| budgets.

| Spec item | Status | Evidence |
|---|---|---|
| Findings ranked by money, act on them | **Built** | act / dismiss |
| Cost by operator / agent / model / tool | **Built** | |
| Proven vs unproven, productive ratio | **Built** | Strip |
| Wasted spend | **Built** | |
| Budgets and set | **Built** | `set_spend_budget`, plus the wrapped-session ceiling and model lists (`update_tacho_session_policy`) |
| Export statement | **Built** | CSV via `export_statement` |
| Cache hit rate | **Partial** | On Fleet tiles, not on Spend |
| Provider key / task as first-class dims | **Missing** | `SpendGroupKind` is only operator, agent, model, and tool. `SpendRow.provider` is the model vendor, not a provider key, and there is no task grouping |
| Reconciliation | **Cut** | |

Closest workspace page to the scaled-back job.

---

## 9. Organization (`/{org}`) (+ `/roles`, `/api-keys`, `/model-funding`)

Feature: `apps/app/src/features/organization/`.

| Spec item | Status | Evidence |
|---|---|---|
| People, change role, remove | **Built** | |
| Pending invitations list | **Partial** | Read-only; no send-invite action |
| Workspaces create / rename / archive | **Built** | In-app form |
| Roles and grants | **Built** | |
| API keys create / rotate / revoke | **Built** | |
| Model funding (BYOK) | **Built** | Test / save / remove |
| Set model route | **Partial** | The wrapped-harness allowlist is on Spend › Budgets (`update_tacho_session_policy`). Routing for the in-app assistant is still unbuilt. |
| Data plane UI | **Missing** | Effectively cut for rev1 |
| SSO / SCIM | **Cut** | |

---

## 10. Billing (`/{org}/billing`)

Feature: `apps/app/src/features/billing/`.

| Spec item | Status | Evidence |
|---|---|---|
| Plan and GAU vs allowance | **Built** | |
| Contracted rate | **Built** | |
| Buy GAU / auto top-up | **Built** | |
| Usage credits and packs | **Built** | |
| Invoices | **Built** | |
| Change plan (Build / Scale Checkout) | **Built** | |
| Proven spend as report only | **Built** | Copy and meters; not priced |

Closest org page to the scaled-back job.

---

## 11. Audit (`/{org}/audit`)

Feature: `apps/app/src/features/audit/`. Export at `/{org}/audit/export`.

| Spec item | Status | Evidence |
|---|---|---|
| Control-plane events and filters | **Built** | `query_audit_log` |
| Export (CSV / NDJSON) | **Built** | `export_audit_events` |
| Incidents | **Missing** | |
| Receipts | **Missing** | |
| Keys / retention UI | **Missing** | Key rotate lives on Organization › API keys |
| Legal holds / crypto-shredding | **Cut** | |

---

## Cross-cutting (blocks pages above)

| Capability | Spec phase | Effect on the UI |
|---|---|---|
| Published records reach a wrapped agent | Phase 0+ | Steering pages write ceremony that may not change Claude Code or Codex until delivery holds |
| `assembleSteering` and Preview | Phases 1-2 | Steering hub incomplete |
| Loopback model proxy and MCP aggregator | Phase 4 | Budget and model allowlist now enforce (`update_tacho_session_policy`). No gateway-tier halt or injection yet. |
| Contained tier | Phase 5 | No "enforced" tier |
| Witness runner and DoD settle | Prove / §8.6 | Fleet and Run lack verdict and certificate |
| Ledger run token | WL-61 | Halt and cancel stay disabled on ledger runs |
| Ontology engine | **Cut** | `/{org}/{ws}/knowledge/**` redirects to Fleet or Steering |

---

## Priority

**P0 (spec says ship; UI empty or misleading)**

1. Approve and deny (`resolve_approval`) on Fleet, and on Run once the run link works. Built, #3516.
2. Run Proof and definition of done (#2955).
3. Ledger halt token (WL-61) so Run controls are not disabled without a path to enable them.

**P1 (depth on pages that already exist)**

4. Tools Auto-approvals (#2970), grant mandate, connections owners.
5. Skills resolution surface (#3098), or bring `ARCHITECTURE.md` down to inventory-only.
6. Fleet DoD column; Run Policy strip (#3286). Fleet's enforcement tier column is built, #3705.
7. Mandate detail route (#2957); Organization send-invite.

**P2 (Phase 2 and the refactor path)**

8. Steering hub (seven tabs) and fold Skills.
9. Preview and the assembler.
10. Audit incidents, receipts, retention.

**Do not build (cut)**

Ontology engine, SSO/SCIM, policy simulation, assurance suite, two-person mandates, steering effect and retirement, legal holds, crypto-shredding, Spend reconciliation.

---

## Scorecard (against scaled-back §14)

| Page | Fit | One-line reason |
|---|---|---|
| Billing | ~95% | Two meters and the purchase path are live |
| Spend | ~85% | Findings, rollups, waste, budgets, export; no provider-key or task dims |
| Organization | ~80% | Send-invite and model route missing |
| Agents | ~75% | Detail, register and the kill switch work; grant and mandate detail thin |
| Fleet | ~70% | Runs, tiles, approve/deny, run controls and tier work; DoD missing |
| Tools | ~50% | Four of six tabs; no policy or auto-approvals |
| Run | ~55% | Player, cost and approve/deny work; export has no download; proof, DoD, policy, bisect missing |
| Audit | ~40% | Events and export only |
| Steering | ~35% of today / ~15% of Phase 2 hub | Three tabs of seven |
| Skills | ~15% of ADR-090 | Inventory only; extra nav vs the nine-page target |
| Approvals | ~80% | Decision dialog on Fleet and Run, with a required denial reason and the eligibility line; the four-hop chain stays thin |

---

## Related artifacts

| Path | Role |
|---|---|
| https://github.com/macanderson/roadmap `docs/mission-control-spec.md` | Canonical product spec |
| https://github.com/macanderson/roadmap `docs/scope-review.md` | What was cut on 2026-09-14 |
| `docs/specs/mission-control/spec.md` | Oxagen-carried copy (diverged; do not prefer) |
| `docs/mission-control/PLAN.md`, `TRACEABILITY.md` | Pre-scale-back planning (2026-09-12) |
| `apps/app/ARCHITECTURE.md` | Rev1 law for the app; some rows still ahead of the code (Skills, Approvals) |
| `docs/audits/2026-09-18-steering-graph-gateway-review.md` | Gateway and steering phase status |
