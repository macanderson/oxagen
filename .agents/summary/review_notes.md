# Review Notes

## Consistency Check

No inconsistencies found between documents. Cross-references verified:
- Schema count (16) consistent across `codebase_info.md`, `architecture.md`, `data_models.md`
- Surface list (api/mcp/agent/cli/app) consistent across `architecture.md`, `interfaces.md`
- Package list consistent between `codebase_info.md` and `components.md`
- Gate injection pattern described consistently in `architecture.md`, `interfaces.md`, `workflows.md`

## Completeness Gaps

### Not Documented (Future Work)

1. **`packages/ui` component catalog** — No inventory of specific UI components beyond the package description. Individual component APIs (Button variants, Toast system, Combobox) not documented. Impact: low for backend-focused agents.

2. **Detailed Postgres migration workflow** — How to create a new migration (Atlas diff → review → apply) is referenced but not step-by-step. See `CONTRIBUTING.md` once generated.

3. **`ops/modal-sandbox`** — Python Modal sandbox (`main.py`, `runner.py`) not deeply documented. It's an isolated FastAPI service for agent code execution; low impact for most development tasks.

4. **`tools/env-manager` internals** — The local secrets manager web UI (`server.ts`) and its Vercel env sync are described at a package level but not implementation detail. Consult `tools/env-manager/src/` directly.

5. **E2E test structure** — `apps/app/e2e/` Playwright setup, fixture helpers, and test organization not documented. See `apps/app/playwright.config.ts` and `e2e/helpers/`.

6. **`docs/capabilities/` individual capability docs** — 140+ files exist but are not indexed here. Use `docs/capabilities/_index.md` for the full list.

7. **`packages/ai` model catalog details** — The full list of supported models, tier assignments, and provider routing logic is in `src/models.ts` and `src/catalog.ts` but not summarized in documentation.

8. **Vercel deployment topology** — How the four Vercel projects relate, how env vars are synced, and the `vercel.json` routing is documented at a high level only.

### Language / Tooling Limitations

- Python code in `ops/modal-sandbox/` is covered structurally but not at the function level (tool only parses TypeScript/JavaScript deeply).
- Shell scripts (`atlas-dev-setup.sh`, `run-all-tests.sh`) described by purpose only.

## Recommendations

All four recommendations below were implemented (2026-06-21).

1. ✅ **Agent-execution content added to `workflows.md`** — new "Agent Execution Telemetry (Four-Store Sync)" section covering the unified `agent_executions` log, Postgres→Neo4j→ClickHouse sync, and the `workflow_runs` vs `agent_executions` distinction. Sourced from `docs/specs/agent-execution/` (the folder is under `docs/specs/`, not `docs/architecture/` as originally noted).
2. ✅ **`docs/adr/` decisions linked into `architecture.md`** — ADR-009 (unified capability model) and ADR-013 in §Capability Kernel; ADR-001/003/012 in §Data Storage Boundaries; ADR-006/014 in §Multi-tenancy; ADR-002/007/010/011 in §Background Job Architecture; plus a complete ADR index table mapping all 14 ADRs to their relevant sections.
3. ✅ **`data_models.md` maintenance note added** — points at `packages/database/src/schema/_schemas.ts` as source of truth (verified at 16 schemas) with a `grep -c 'pgSchema('` verification command and a note to keep the count in sync across the four files that assert it.
4. ✅ **Regeneration SOP documented in `index.md`** — note: there is **no** `pnpm docs:generate` script (the original recommendation referenced a command that does not exist). The accurate path is re-running the `doc-updater` agent / `/update-docs` + `/update-codemaps` skills, followed by hand-verifying the drift-prone facts (schema count, surface list, `pnpm check:manifest`, ADR links).
