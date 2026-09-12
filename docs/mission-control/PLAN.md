# Mission Control — build plan

Status: draft, 2026-09-12.
Source of truth: `~/Documents/Oxagen/Specs/2026-09-11-oxagen-mission-control-spec.md`
(§14 Mission Control, §16 carry over / leave behind, §17 delivery plan, Appendix A/E/F).
Reference implementation: `~/Documents/Oxagen/Mockups/mc.html`.

This plan does not restate the spec. It records the decisions the spec left open, the
measurements that back them, and the order the work happens in.

---

## 1. The finding that shapes everything

The spec is not 90% written and 10% missing. It is ~97% decided, and the remaining work is
**extraction**, not design. Three artifacts already agree:

| Artifact | Measured | Agreement |
|---|---|---|
| Spec Appendix F | 70 routes collapse to 10 pages | `apps/app` has exactly **70** `page.tsx` files |
| Spec Appendix E | 229 contracts collapse to 96 tools | `packages/oxagen/src/contracts/` declares **228** |
| `mc.html` `route()` | emits 10 pages | the **same 10**, at the **same route shapes** |

Appendix E says every target tool needs "an input schema, an output schema, a risk grade, and
a default effect." Measured against the live tree:

- **205 of 228** live contracts already declare both a Zod `input` and `output`.
- **207** declare `agent.riskLevel`; **228** declare `defaultEffect`.
- **74 of the 96** target tools have every absorbed contract resolving to a live file.

So 77% of the "missing" schema layer is already written, tested, and in production. It needs
to be *carried*, not authored. See `TOOL-MATRIX.md` for the row-by-row mapping.

## 2. Decisions

### 2.1 The frontend is kept and emptied. It is not rebuilt.

Measured in `apps/app`:

| Layer | LOC | Disposition |
|---|---|---|
| `src/app` — 70 routes | 80,652 | 52 absorbed, 9 sign-in/callback stay, 9 fold into survivors |
| `src/components` | 99,680 | ~85,000 belongs to deleted pages |
| ↳ `shell`,`ui`,`auth`,`avatar`,`brand`,`loading`,`lists`,`org`,`workspace`,`pwa` | 14,616 | **keep** |
| `src/hooks` + `src/lib` | 14,412 | mostly keep |
| `packages/ui` | 9,860 | **keep** |

The stack — `next@16.3.1`, `react@19.2.6`, `@base-ui/react`, Tailwind, `better-auth`,
`lucide-react`, `motion` — is current and is what a greenfield choice would land on.

The deciding detail is the design system, not the framework: `packages/ui/src/styles/globals.css`
already implements the house brand the mockups are drawn in (Space Grotesk at 600, `--ink`
tokens, and an explicit "Space Grotesk is not a code face" rule). A rewrite would discard the
one layer that is already correct.

**Decision: keep the app shell and the kit. Delete ~85% of what is inside. Rebuild the ten
pages against the mockup.**

### 2.2 Map before delete

Deletion is the right first move — every later step's cost scales with what is still in the
tree — but it runs second, not first.

The asset inside the 47 unabsorbed contracts and the ~85k LOC of components is not the code.
It is the **encoded decisions**: Zod schemas, validation messages, edge cases that were hit in
production. Appendix E's `Absorbs` column is a file-level migration map; deleting before
extracting means re-deriving from DDL what already exists in TypeScript and passes tests.

**Order: map (§3) → harvest → delete → rebuild.**

### 2.3 "Absorbed" and "folded into" are different, and the split is not mechanical

The generated deletion manifest classifies a contract as a deletion candidate when no target
tool names it in `Absorbs`. That is a binary test, and the spec is not binary: Appendix E says
of `list_roles` that it is "folded into `get_agent` and the Tools page." A folded read side is
not a deletion — its schema still has to land somewhere.

Contracts flagged as candidates that are probably folds, not deletes, and need a human call:
`list_iam_roles`, `get_org_settings`, `get_workspace_settings`, `get_prompt_settings`, and the
four `repo/*` reads (`get_pr`, `get_pr_diff`, `list_branches`, `get_ci_status`) — the spec
keeps the GitHub App and the code graph.

**The deletion manifest is a proposal that gets reviewed, never executed blind.**

## 3. Phases

| Phase | Delivers | Done when |
|---|---|---|
| **P0 Map** | `TOOL-MATRIX.md`, the route classification, the deletion manifest, all regenerable from the spec | The matrix regenerates from a clean checkout and the counts match this document |
| **P1 Harvest** | Every `INHERIT` tool's carried schema extracted to `packages/oxagen/src/contracts/v2/`, with the absorbed sources cited per file | 74 tools have an input schema, an output schema, a risk grade, and a default effect, each traceable to the contract it came from |
| **P2 Delete** | The reviewed deletion manifest applied: unabsorbed contracts, absorbed routes, page-bound components, and the leave-behind packages | `pnpm typecheck` and `pnpm test` pass. No route 404s that Appendix F says should redirect |
| **P3 Fixtures** | `mc.html`'s `DB`/`AGENTS`/`ORG` extracted to typed fixtures shared by the UI and the handler tests | A screen and its handler assert against the same fixture |
| **P4 Design** | The 22 `NEW` tools' schemas, written against Appendix A's DDL and the mockup's rendered fields | Each has a schema, a risk grade, a default effect, and a test |
| **P5 Run slice** | `/{org}/{ws}/runs/{run}` end to end — frame player, transport, cost strip, chain status | The §17 M1 acceptance test: a run can be halted mid-loop from the UI, and an exported run verifies offline |

P5 is deliberately the hardest screen. It exercises the frame envelope, the ledger invariants,
and the recorder in one pass. Fleet is easier and teaches nothing that de-risks the rest.

## 4. What the 22 new tools actually are

They are not scattered. They cluster into the governance model that has no equivalent today:

| Cluster | Tools | Milestone |
|---|---|---|
| Mandates | `grant_mandate`, `revoke_mandate`, `list_mandates` | M2 |
| Policy | `set_policy`, `simulate_policy` | M2 |
| Kill switches and approval rules | `set_kill_switch`, `set_approval_rules`, `approve_tool_schema`, `list_approvals` | M2 |
| Agent messaging | `send_message`, `list_messages` | Series A (§7.6) |
| Spend truth | `get_reconciliation`, `export_statement`, `set_funding_source` | M2/M5 |
| Audit surface | `set_legal_hold`, `list_incidents`, `set_event_subscription`, `list_event_subscriptions` | M5 |
| Other | `set_role_grants`, `export_run`, `load_tools`, `get_record` | M1–M3 |

Fourteen of the twenty-two are M2 Control. **M2 is the real build; M0/M1 are largely a carry.**

## 5. Regenerating the map

```sh
node tools/scripts/mission-control/extract-contracts.mjs packages/oxagen/src/contracts contracts.json
node tools/scripts/mission-control/build-matrix.mjs <spec.md> contracts.json matrix.json
node tools/scripts/mission-control/build-routes.mjs <spec.md> apps/app routes.json
node tools/scripts/mission-control/emit-matrix-md.mjs matrix.json matrix-orphans.json docs/mission-control/TOOL-MATRIX.md
```

The matrix is generated, never hand-edited. If a count in this document disagrees with a fresh
run, the document is wrong.
