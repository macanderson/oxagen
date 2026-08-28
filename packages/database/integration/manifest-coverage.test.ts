/**
 * RLS Manifest Coverage
 *
 * Asserts that:
 * 1. Every table with an org_id column (outside the allowlist and system schemas)
 *    appears in POLICY_MANIFEST.
 * 2. Every table with a workspace_id column but NO org_id is in the manifest
 *    as "workspace_only" (or allowlisted) — catches the workspace_users class
 *    of gap where there is no org_id to key an org-level policy.
 * 3. Every manifest table actually has relforcerowsecurity = true in pg_class.
 *
 * Runs against a real migrated Postgres (CI: rls-integration job;
 * locally: DATABASE_URL=... pnpm --filter @oxagen/database test:integration).
 */
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { POLICY_MANIFEST } from "../src/tenant-policy.manifest";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

afterAll(() => sql.end({ timeout: 5 }));

// Tables that legitimately have org_id but are intentionally NOT row-scoped.
// Empty: every org_id-bearing table in the schema is in the manifest
// (workspace.workspaces is org_only; org.organizations, billing.plans,
// billing.stripe_events have no org_id column so they never match the
// coverage query). Add entries here ONLY with a written reason.
const ALLOWLIST = new Set<string>([]);

// Tables that have workspace_id but no org_id and are allowlisted (not
// workspace_only-policy candidates).
// Currently empty — workspace_users is in the manifest as workspace_only.
const WS_ONLY_ALLOWLIST = new Set<string>([]);

describe("RLS manifest coverage", () => {
  it("every table with an org_id column is in the manifest or allowlist", async () => {
    // Exclude child partitions (relispartition = true): they inherit their
    // parent's RLS policy when accessed through the parent and are never
    // independently policied. The partitioned parent itself (relispartition =
    // false) is still required to be in the manifest.
    const rows = await sql<{ schema_name: string; table_name: string }[]>`
      SELECT col.table_schema AS schema_name, col.table_name
      FROM information_schema.columns col
      WHERE col.column_name = 'org_id'
        AND col.table_schema NOT IN ('public', 'information_schema', 'pg_catalog')
        AND NOT EXISTS (
          SELECT 1
          FROM pg_class pc
          JOIN pg_namespace pn ON pn.oid = pc.relnamespace
          WHERE pn.nspname = col.table_schema
            AND pc.relname = col.table_name
            AND pc.relispartition = true
        )
      ORDER BY col.table_schema, col.table_name
    `;

    const owned = rows.map((r) => `${r.schema_name}.${r.table_name}`);
    const covered = new Set(POLICY_MANIFEST.map((e) => e.table));
    const missing = owned.filter((t) => !covered.has(t) && !ALLOWLIST.has(t));

    expect(
      missing,
      `Tables with org_id not in manifest or allowlist: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every table with workspace_id but no org_id is manifest workspace_only or ws-allowlisted", async () => {
    // Find tables that have workspace_id but do NOT have org_id — these cannot
    // use an org-keyed policy and must be workspace_only or explicitly allowlisted.
    const rows = await sql<{ schema_name: string; table_name: string }[]>`
      SELECT ws.table_schema AS schema_name, ws.table_name
      FROM information_schema.columns ws
      WHERE ws.column_name = 'workspace_id'
        AND ws.table_schema NOT IN ('public', 'information_schema', 'pg_catalog')
        AND NOT EXISTS (
          SELECT 1
          FROM information_schema.columns org
          WHERE org.table_schema = ws.table_schema
            AND org.table_name = ws.table_name
            AND org.column_name = 'org_id'
        )
      ORDER BY ws.table_schema, ws.table_name
    `;

    const wsOnly = rows.map((r) => `${r.schema_name}.${r.table_name}`);

    // Every such table must be in the manifest as workspace_only or in the ws allowlist.
    const manifestWsOnly = new Set(
      POLICY_MANIFEST.filter((e) => e.policyClass === "workspace_only").map(
        (e) => e.table,
      ),
    );

    const missing = wsOnly.filter(
      (t) => !manifestWsOnly.has(t) && !WS_ONLY_ALLOWLIST.has(t),
    );

    expect(
      missing,
      `Tables with workspace_id (no org_id) not covered as workspace_only: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every manifest table actually has RLS forced (relforcerowsecurity = true)", async () => {
    // relkind 'r' = ordinary table, 'p' = partitioned parent. A partitioned
    // table (e.g. security.security_events) carries relforcerowsecurity on the
    // parent; its children inherit enforcement, so the parent is what we check.
    const rows = await sql<{ rel: string }[]>`
      SELECT (n.nspname || '.' || c.relname) AS rel
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND c.relforcerowsecurity = true
    `;

    const forced = new Set(rows.map((r) => r.rel));
    const notForced = POLICY_MANIFEST.filter((e) => !forced.has(e.table)).map(
      (e) => e.table,
    );

    expect(
      notForced,
      `Manifest tables missing FORCE ROW LEVEL SECURITY: ${notForced.join(", ")}`,
    ).toEqual([]);
  });

  it("every manifest table carries a tenant_isolation policy", async () => {
    // FORCE RLS without a policy is default-deny — the app would brick, not
    // leak — but the dangerous failure mode is the opposite: an Atlas
    // re-baseline that regenerates tables WITHOUT the policy DDL.
    // relforcerowsecurity alone would also be lost in that case, but assert
    // the policy explicitly so a partial loss (table recreated, FORCE
    // re-added by hand, policy forgotten) is caught too.
    const rows = await sql<{ rel: string }[]>`
      SELECT (schemaname || '.' || tablename) AS rel
      FROM pg_policies
      WHERE policyname = 'tenant_isolation'
    `;
    const policied = new Set(rows.map((r) => r.rel));
    const missing = POLICY_MANIFEST.filter((e) => !policied.has(e.table)).map(
      (e) => e.table,
    );

    expect(
      missing,
      `Manifest tables missing the tenant_isolation policy: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
