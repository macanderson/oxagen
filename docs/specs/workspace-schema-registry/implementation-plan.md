# Workspace Schema Registry — Implementation Plan (parallel-optimized)

> **Launch-boundary addendum (2026-07-21):** this executed plan predates removal
> of generic graph mutation and inference-trigger capabilities. Its registry and
> validation work remains useful; mutation/alias tasks below are historical and
> must not be re-landed.

Companion to `spec.md`. Optimized for **wall-clock speed via maximum safe
parallelism**: agents work concurrently on **disjoint file sets** so they never
collide, all on one branch in one worktree. Scope here is **v1** (define /
version / validate / export / enable-disable / ingestion grounding + the legacy
relationship rename + the Storybook visual gate). Reconcile workers, prune, and
Playwright E2E are **v2** (see §V2).

---

## 0. Worktree setup (do this first, do NOT ask)

Cut an isolated worktree from the **remote `main`** so the work is based on the
latest pushed tree, not a stale local cut. Per CLAUDE.md operating mode.

```bash
# from the primary checkout
git fetch origin
git worktree add ../oxagen-schema-registry -b feat/schema-registry origin/main
cd ../oxagen-schema-registry

# worktree gotcha (project memory): copy env files in before pnpm dev
cp ../oxagen-platform/.env.local . 2>/dev/null || true
for app in apps/app apps/api apps/mcp apps/cli; do
  cp "../oxagen-platform/$app/.env.local" "$app/.env.local" 2>/dev/null || true
done

git push -u origin feat/schema-registry   # back up + make visible immediately
```

- The worktree's branch `feat/schema-registry` is **based on `origin/main`**.
- **Every subagent works in THIS worktree, on THIS branch**, and commits +
  pushes frequently. Tell each one the branch name and the worktree path.
- **Restate verbatim to every subagent:** *"NEVER run all tests. Run ONLY the
  narrow tests for the files you changed — a single package's `test:unit` or one
  test file. Do not run `pnpm test`, `turbo run test`, or `pnpm gate`."*

---

## 1. Dependency graph (what gates what)

```
        ┌─────────────────────── Phase 0 (foundation) ───────────────────────┐
        │  F1 contracts + RELATIONSHIP_TYPE_PATTERN     F2 DB schema (drizzle) │
        └───────────┬──────────────────────────────────────────┬─────────────┘
                    │ (contract types)                          │ (table defs)
   ┌────────────────┼───────────────┬───────────────┬───────────┴───────┐
   ▼                ▼               ▼               ▼                     ▼
 A handlers      B API+MCP       C CLI          D App UI            E migrations
 +ingestion      (apps/api,      (apps/cli)     (apps/app           (atlas + CH,
 (packages/      apps/mcp)                       schema-builder      from F2)
  handlers,                                      + Storybook)
  packages/                                                         F docs
  ingestion)                                                        (docs/capabilities)
   └──────────────── all reconverge ────────────────────────────────────┘
                              ▼
                     Phase 2: integration + v1 gate → PR
```

- **Phase 0 is the only hard barrier.** Nothing in Phase 1 can finish before
  F1+F2 land, because handlers need both and every surface codes against the
  contract types. Keep Phase 0 small and fast, then fan out.
- **Phase 1 streams touch disjoint directories** (table below) → run them as
  concurrent subagents with zero merge risk.

---

## 2. Phase 0 — Foundation (2 concurrent agents, keep it tight)

| Agent | Package | Deliverable | Files (disjoint) |
|---|---|---|---|
| **F1 — Contracts** | `packages/oxagen` | All `schema.*` contract definitions (§5 table); extract `RELATIONSHIP_TYPE_PATTERN` into a shared module both the registry validator and ontology guards import; **rename `graph.edge.upsert`→`graph.relationship.upsert`, `semantic.edge.*`→`semantic.relationship.*`** with one-release deprecation aliases (old name re-exports/forwards + deprecation note). | `packages/oxagen/src/contracts/schema.*.ts`, `graph.relationship.upsert.ts`, `semantic.relationship.*.ts`, alias shims, `src/lib/relationship-type-pattern.ts` |
| **F2 — DB schema** | `packages/database` | Drizzle tables for the `schema_registry` schema (§4.1–4.6 — registries, schema_versions, schemas+activation, node_labels, relationship_types, properties); register schema in `_schemas.ts`; relations in `relations.ts`. **No bespoke reconcile table** (reuses `agent_executions`, §4.7). ClickHouse DDL files for `graph_observed_labels` (§4.9) and `schema_conformance_events` (§4.10). | `packages/database/src/schema/schema-registry.ts`, `_schemas.ts`, `relations.ts`, ClickHouse migration files |

Both commit + push as soon as their piece typechecks. **Gate to Phase 1:** F1
exports the contract names/types and the pattern module; F2 exports the table
objects. (Atlas SQL migration is generated in Stream E, after F2's schema is
final, to avoid churn.)

---

## 3. Phase 1 — Parallel fan-out (6 concurrent streams, disjoint files)

Each is an independent subagent. Disjoint paths in the right column = safe to run
all at once.

| Stream | Owns | Key work (v1) | Paths (disjoint) |
|---|---|---|---|
| **A — Handlers + ingestion** | `packages/handlers`, `packages/ingestion` | Handler impl for every `schema.*` contract; the **shared validator** `validate/schema.ts` (backs both `schema.validate.node/relationship` and the pipeline); `getPinnedSchema` resolver (active-vocabulary, §4.8); grounding injection in `infer/index.ts`; property validation in `mutations/upsert-entity.ts` (§8); `graph_observed_labels` emission; **swap the `GRAPH_EDGE_TYPES` guard** in `ontology.neighbors.ts`/`ontology.query.ts`/`graph.ingest.ts` to `RELATIONSHIP_TYPE_PATTERN` + active-vocab membership (§3.2). Stub `schema.reconcile.dispatch/status` (v2). | `packages/handlers/src/schema.*.ts`, `ontology.*.ts`, `graph.*.ts`; `packages/ingestion/src/{validate,pipeline,infer,mutations}/*` |
| **B — API + MCP** | `apps/api`, `apps/mcp` | Combined `schema.ts` route (all `schema.*`, thin `invoke()` wrappers) mounted in `app.ts`; matching MCP tools file. Document the `check:manifest` combined-file false-positives in the route header. | `apps/api/src/routes/v1/schema.ts`, `apps/api/src/app.ts`, `apps/mcp/src/tools/schema.ts` |
| **C — CLI** | `apps/cli` | `schema` command group (get/config/label/relationship/property/version/pin/list/diff/export/recommend/validate/list/toggle) + the `oxagen schemas setup` Ink wizard (§5.3) with `--sample-limit`, `--enforcement`, `--no-interactive`, `--json`. | `apps/cli/src/commands/schema/*` |
| **D — App UI + Storybook** | `apps/app` | `schema-builder/` components (§6): builder, label/relationship editors, property table, onboarding recommendation (with inference-depth control), **`schema-assistant-drawer` (the AI assistant drawer — generative multi-schema scaffold + additive re-prompt; existing `use-tool-stream.ts` transport + `agent.ui.render`, no `ai/rsc`)**, version-history/diff, pin-change dialog (prune knob; fires after activation auto-pins), export button, **schema-list with activate/deactivate toggles (activation auto-publishes + pins, §1.4)**; the Settings→Knowledge→Schema route; the `/api/v1/graph/explore`-style API client. **A Storybook story for every new component** (app SB :6007). UI imports via `@/components/ui/*` only. | `apps/app/src/components/knowledge/schema-builder/*`, settings route, `*.stories.tsx` |
| **E — Migrations** | `packages/database` (migrations) | After F2 lands: generate the Atlas migration for the five Postgres tables (indexes/uniques/checks/RLS per §10–§11); finalize ClickHouse DDL. Verify locally against `:5433` (`unset DATABASE_URL`; `SELECT` after). Migration files in `packages/database/migrations/` only. | `packages/database/migrations/*` |
| **F — Docs** | `docs/capabilities` | One `docs/capabilities/<schema.*>.md` per contract + `_index.md` update; deprecation notes for the renamed `graph.relationship.*`/`semantic.relationship.*`. | `docs/capabilities/*` |

**Coordination notes**
- Stream B/C/D code against F1's **contract types** immediately; they reach real
  data through `invoke()` as Stream A's handlers land. Where a handler isn't
  ready, B/D use the contract's typed shape with a temporary fixture, swapped at
  integration — no blocking.
- If Stream D is the long pole, split it: **D1** = editors + property table +
  schema-list; **D2** = chat + onboarding + version/pin/export. Disjoint files,
  still safe.
- Each stream writes its **unit tests beside the code** and bumps coverage
  thresholds only up to `floor(current − 2.5)`, capped at 90 (CLAUDE.md ratchet).

---

## 4. Phase 2 — Integration + v1 completion gate

Run in the worktree, in this order. Narrow commands only.

1. **Wire UI→API:** replace Stream D fixtures with live `invoke()` calls; smoke
   one full flow headlessly (define label → version → pin → export) via
   `tsx`/`curl` and assert the JSON (no browser needed for the data path).
2. **Per-package narrow tests** for every package touched (e.g.
   `pnpm --filter @oxagen/ingestion test:unit -- validate/schema.test.ts`).
   **Never the full suite.**
3. **Cypher-injection regression** (Stream A): malicious relationship-type string
   rejected by `RELATIONSHIP_TYPE_PATTERN`; pinned-version membership enforced.
4. **Capability parity:** `pnpm check:manifest` (expect documented combined-file
   false positives) + `pnpm check:contracts`.
5. **Storybook visual gate (v1 requirement, replaces E2E for v1):**
   - Build/serve app Storybook (**:6007**) and `@oxagen/ui` Storybook (**:6008**).
   - Capture **light + dark** screenshots for every new story into a gitignored
     dir, recreated each run. *(Worktree has no system Chrome — run
     `pnpm --filter @oxagen/app exec playwright install --with-deps chromium`
     first, per project memory.)*
   - **LLM-judge** each screenshot for WCAG-AA contrast failures and style/layout
     bugs (overflow, clipping, misalignment, theme-token misuse). Gate **fails on
     any high-severity finding**; fix and re-shoot until clean.
6. **`test-completeness-judge`** until APPROVED (gates PR opening).
7. **Golden three-command gate + full gate** (CLAUDE.md, run once, pre-merge):
   `pnpm i --no-frozen-lockfile` → `pnpm build` → `pnpm kill && pnpm dev` → `pnpm gate`.
8. **Open the PR** against `main`, push final commits, `gh run watch` until green.

---

## 5. Speed levers (why this is fast)

- **One barrier only** (Phase 0). After it, six streams run fully concurrently on
  disjoint trees — wall-clock ≈ Phase 0 + slowest single stream (Stream D), not
  the sum.
- **Surfaces code against contract types, not finished handlers** — B/C/D don't
  wait on A.
- **Migrations (E) and docs (F) run alongside code**, not after.
- **Worktree isolation** means this branch never contends with the parallel
  sessions/optimizer on the primary checkout.
- **Commit + push per stream continuously** — no big-bang merge at the end.

---

## V2 (separate follow-up branch, also worktree off `origin/main`)

Not in this build; deferred per spec §14:
- **Reconcile workers + prune:** Inngest fanout recorded on `agent_executions`
  (`origin_type='schema.reconcile.dispatch'`, counters in `state`/`output_payload`,
  prune audit → ClickHouse). `schema.reconcile.dispatch/status` go from stub to live.
- **Playwright E2E** suite in `apps/app/e2e/` for the full builder→version→pin→
  export→toggle journeys, screenshots to `e2e/screenshots/`.
- **Batch `:EntityNode {entityType}` → first-class-label relabel** migration (§3.3).
```
