## Self-Evaluation — billing statements (get_billing_statement, export_billing_statement) — 2026-09-23

### What I set out to do
Build billing statements for a week, month, quarter, year, or a custom period longer than 48 hours. Each statement is built from the ledgers, labelled, reconciled, and exportable as CSV (every ledger row, paged) and printable HTML. Deliver them on API, MCP, CLI, the Billing page and an operator script.

### What I actually did (measurable deltas)
- @oxagen/billing: statements.ts (period resolution, assembly, cursor), statement-reads.ts (Postgres reads in one withOrgDb transaction), statement-render.ts (CSV, HTML).
- Two contracts, two handlers, two API routes, two MCP tools, one CLI command, capability docs and index, a ui-map binding, a Billing page section with a component test, an operator script, and a published docs page.
- Tests: 27 statements unit, 17 render, 1 import guard, 3 pg (run for real against a scratch Postgres 16 with all 199 migrations, as superuser and as a non-superuser with RLS enforced), 8 contract, 11 handler, 4 MCP, 6 CLI, 6 script, 13 component, 98 Billing page.

### Quality of my decisions
- Best: running the pg test against a real migrated database. It caught drizzle rendering outer columns unqualified inside correlated subqueries. `"stripe_invoice_id" = "stripe_invoice_id"` would have attached an arbitrary invoice to every settlement, and every unit test was green.
- Weakest: putting `schema.*` reads at module scope in statement-reads.ts, which the repo has already been burned by (gauRemainingSql). The lead had to flag it.

### What I could have done better
1. Grep shared lessons and gau-bucket.ts for "module scope" before writing a module that the package barrel re-exports. The incident note was in the file next door.
2. Run `node tools/scripts/check_manifest.mjs` right after creating the contracts. Its unit layer needs `contracts/<stem>.test.ts` per stem, and I had one combined file.
3. Run the generators and `pnpm check:*` less often. pnpm 11 auto-installs before scripts, and each install relinked the shared tree while other agents were testing.

### What surprised me about this codebase/product
- Drizzle interpolates a column in a SELECT field as `"col"` with no table, so correlated subqueries must name outer columns explicitly.
- `withOrgDb` exists for exactly this kind of org-wide read (ADR-086), and `withTenantDb` with the org-only sentinel would raise on `standard` tables.
- The app's layer rules forbid a feature importing @oxagen/billing, so the form keeps its own period helper.

### Risks I am leaving behind (untouched on purpose, and why)
- The operator script writes no security event. A new event type needs a CHECK migration, which is a stop-and-surface item.
- The permission catalogue does not list the two new capabilities. Adding them to `invoice.read` changes what existing custom roles hold, which is an authz change.
- Reads run at READ COMMITTED, so a provisional statement's sections can see commits that land between reads.
- No feature flag: the section is read-only and role-gated, and the repo's app has no flag convention for billing sections.

### Confidence in the result: medium-high
Evidence: real-database tests under RLS, a mutation check on the subquery fix, typecheck of every touched file, and the check:contracts, check:manifest, check:ui-parity and check:prose runs. CI's package-wide suites have not run.
