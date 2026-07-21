# Agent RBAC — resume punch-list

Branch `feat/agent-rbac`, PR #1075. Build was executed by Claude Code subagents
(the stella fleet route was abandoned after both BYOK keys ran out of credits).
Work halted **2026-07-21 ~10:56 PT** on a hard **account session limit** that
resets **2026-07-22 03:00 PT (~16h)**. Everything below is pushed and durable.

## DONE (pushed, tested green)

- **Phase 1 — principals + role spine.** resourceScope condition type
  (`packages/oxagen/src/iam/conditions.ts`) + delegation-ceiling resolver
  (`resolve.ts`); agent principal provisioned on `agent.definition.create`,
  soft-deleted on delete; two-principal AuthzContext
  (`packages/iam/src/agent-run-context.ts`). `agent.role.assign/revoke/list/get`
  contracts with delegation ceiling, tier gating (system roles all tiers, custom
  = enterprise), default "Agent Contributor" on create, API+MCP+docs parity
  (zero manifest gaps). Three system roles seeded (Observer/Contributor/Operator,
  **no Legacy role** per Q1) in `tools/scripts/seed-iam-defaults.ts` + shared lib
  `packages/handlers/src/lib/agent-role-defaults.ts`; `bootstrapOrgIAM` provisions
  them for new orgs. Added missing `iam.role_grants.conditions_jsonb` column
  (migration `20260806090000`). Commits `948b617e`, `d4ae44621`, `1e843c81`,
  plus `037025c4` (added "assign" to the ADR-025 verb lexicon).
- **Phase 2 — kernel + tool gate.** `invoke()` resolves the agent principal
  (∩ human) at ALL tiers, cached once per run on `ctx.agentRun`; tier fast-path
  in `check-iam.ts` restricted to `principalKind='human'`; deny blocks pre-handler,
  require_approval routes through the existing JIT access-request flow (no fork);
  denial audit with lineage. **Poisoned-prompt acceptance test passes** against
  the real kernel. `materialize-tools.ts` allowlist populated from the SAME cached
  resolution (reference-equality proven); turn driver
  (`packages/agent/src/runtime/turn-driver.ts`) attaches `ctx.agentRun` fail-closed;
  enqueue path stamps the invoking user server-side (`apps/api/.../agent.run.ts`).
  Also fixed a pre-existing SSE test OOM. Commits `2ad1610f4`, `8b333ab51`.
- **Phase 3a — scopedSession.** `scopedSession(scope?: GraphScope)` in
  `packages/ontology/src/tenant.ts` + `graph-scope.ts`: label/rel-type predicate
  params (`$__scopeLabels`/`$__scopeRelTypes`), LIMIT/hop/timeout budget clamps,
  read-mode write rejection, seam-bypass guard that throws if markers absent.
  Commit `8be344c77`.

## IN PROGRESS — Phase 3b graph-caller threading (commit `c375a6109`, WIP, COMPILES)

All three touched packages typecheck clean; work is incomplete, not broken.
Landed (additive): `intersectGraphScope` exported from `resolve.ts`; optional
`graphAccess` on the run context (`agent-run.ts`); `effective-graph-scope.ts`
helper (role ceiling ∩ graphAccess); `extend-proposal.ts` validation lib;
`SCOPE_OVERSAMPLE_FACTOR` in `ann.ts`; scope threading started in
`ontology.neighbors`, `ontology.query`, `semantic.edge.list`, `semantic.edge.suggest`.

**To finish (resume here first — it unblocks Phase 4b):**
1. Complete scope predicates in `semantic.edge.list` + `semantic.edge.suggest`
   (agent was mid-`semantic.edge.list` when killed) — verify `$__scopeLabels`/
   `$__scopeRelTypes` land in REAL WHERE predicates, LIMITs are literal (parameterized
   LIMIT fails closed under maxNodes), and post-ANN oversample→filter→truncate is wired.
2. Wire `extend-proposal.ts` into the propose + approve paths (Q3 resolution):
   fail-fast at proposal against the label/rel-type allowlist, re-verify at approval,
   enforce property completeness (reject with the missing-property list).
3. Add `scopeApplied: true` to `graph_query` trace/span logs when a scope is injected.
4. Tests for all 4 handlers + both libs (out-of-scope labels excluded, budget clamps
   observable, ANN oversampling, proposal fail-fast/re-verify/completeness).
5. Amend or follow-up commit; then drop `--no-verify` (tree should pass the hook).

## NOT STARTED

- **Phase 4a — MCP globs.** Shared `evaluatePermission` (re-export from
  `packages/mcp-config/src/permissions.ts`); `apply-agent-binding.ts` serverAllowlist
  becomes an intersection (not union); per-call deny (hide+block) / ask (→ mcp_consents
  first-use, **agent principal as subject**, distinct from user consents, needs a
  subject-kind discriminator + migration) / allow; audit with server:tool dimension;
  tests. (A subagent had full context but wrote nothing before the limit hit.)
- **Phase 4b — skills / subagents / A2A.** Skill index filter + `agent.skill.load`
  gate on `skills.slugs`; `agent.subagent.dispatch` narrowing (child = child role ∩
  parent effective scope, all dimensions — use the resolver's narrowing, don't
  hand-roll); A2A inbound (`apps/api/src/routes/a2a`) intersects target-agent principal
  with caller API-key scope (Q2 resolution); audit; tests. **Depends on 3b** (shares
  the effective-scope helper).
- **Phase 5a — builder UI.** Role picker (create+edit), effective-scope review step
  (role ∩ config across all four dimensions), role badge in the agent list,
  delegation-ceiling disable+tooltip; e2e with screenshots.
- **Phase 5b — suggest + docs.** `agent.definition.suggest` gains an additive
  `suggestedRole` (narrowest adequate role); assign on draft save; user docs for the
  ceiling-vs-request model + delegation ceiling.
- **verify-integration.** Acceptance sweep over the 8 spec criteria; write
  `docs/specs/agent-rbac/agent-rbac-verification.md`.

## Resume dispatch order (after the 03:00 PT reset)

1. Finish Phase 3b (above) — one agent, has the WIP on disk.
2. Then in parallel: Phase 4a (MCP) ∥ Phase 4b (skills/subagents/A2A).
3. Then Phase 5a (UI) ∥ Phase 5b (suggest+docs).
4. Then verify-integration; run `pnpm gate`; mark PR ready.

Keep-out discipline stayed clean throughout (disjoint file ownership per agent).
No local Postgres/Neo4j was reachable, so DB/migration + graph-integration proof is
typecheck+unit level; first live `pnpm db:seed-iam` / `pnpm gate` / CI are authoritative.
