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

1. **Add `docs/architecture/agent-execution/` content** to `workflows.md` — the architecture folder contains more detail on agent execution than was captured.
2. **Link `docs/adr/` decisions** into relevant sections (e.g., ADR-009 on unified capability model belongs in `architecture.md`).
3. **Update `data_models.md`** when new Postgres schemas are added — the 16-schema list will drift as the platform grows.
4. **Re-run this documentation** after major feature additions (plugins phase 2, new connectors) using: `pnpm docs:generate` or by re-running this SOP.
