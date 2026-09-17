#!/usr/bin/env tsx
/**
 * gen-rls-migration.ts — generate bypass-aware Postgres RLS policies from
 * the POLICY_MANIFEST into the Atlas migration directory.
 *
 * Usage:
 *   pnpm tsx tools/scripts/gen-rls-migration.ts [out-file-name.sql] [--only=schema.table,…]
 *   cd packages/database && pnpm exec atlas migrate hash   # re-stamp atlas.sum
 *
 * Default output: packages/database/atlas/migrations/<existing or new>
 * restore_rls_policies file. Pass an explicit file name (e.g.
 * `20260701120000_rls_new_tables.sql`) to emit a fresh follow-up migration
 * after adding tables to the manifest, and `--only=` with the tables the
 * follow-up is for, so it carries their DDL alone: without the filter a
 * follow-up re-emits every manifest table, and a table whose live policy was
 * hand-tuned after the manifest run (skills_builtin_readable_rls) would be
 * reset to the manifest's shape. Every `--only` table must be in the manifest.
 *
 * WHY THIS LIVES IN ATLAS (OXA-1700): the Atlas baseline is generated from
 * `drizzle-kit export`, which emits ONLY what Drizzle models — the 2026-06-11
 * re-baseline silently dropped every ENABLE/FORCE ROW LEVEL SECURITY and
 * tenant_isolation policy (the same failure mode that dropped the oxagen_app
 * GRANTs, see 20260612052000_regrant_oxagen_app.sql). Keeping the policy DDL
 * as a versioned Atlas migration means `atlas migrate apply` replays it on
 * every fresh environment, and integration/manifest-coverage.test.ts fails CI
 * if a future rebuild loses it again.
 *
 * The generated SQL is idempotent (DROP POLICY IF EXISTS + CREATE) so the
 * file can be regenerated in place BEFORE it has shipped. Once applied to a
 * persistent environment it is immutable like any other migration — additions
 * go in a NEW file (pass a file name argument).
 *
 * NOTE: ESM-safe path resolution via fileURLToPath(import.meta.url) — the
 * repo is ESM ("type":"module"). Do NOT use __dirname here.
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POLICY_MANIFEST,
  type PolicyClass,
  type PolicyEntry,
} from "../../packages/database/src/tenant-policy.manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ORG = `nullif(current_setting('app.current_org_id', true), '')::uuid`;
const WS = `nullif(current_setting('app.current_workspace_id', true), '')::uuid`;
const BYPASS = `current_setting('app.rls_bypass', true) = 'on'`;
/**
 * The organisation-wide READ mode, set by `withOrgDb` and by nothing else
 * (ADR-075). It appears in USING and NEVER in WITH CHECK: a read may span the
 * organisation's workspaces, a write may not — `withOrgDb` widens what you can
 * see, never what you can land, so a row still has to name the workspace whose
 * scope the writer is in.
 *
 * It is a disjunct BEFORE the `${WS}` comparison so a shape like
 * `org_wide OR workspace_id = WS` reads as "the organisation, or this
 * workspace". Do not rely on that ordering to avoid the uuid cast: Postgres
 * folds stable functions during selectivity estimation, so `WS` is evaluated
 * at PLAN time whatever the disjunct in front of it says. That is the property
 * the org-only refusal is built on (ADR-075) and the reason `withOrgDb` leaves
 * the workspace GUC empty rather than at the org-only marker.
 */
const ORG_WIDE = `current_setting('app.org_wide', true) = 'on'`;

interface Predicates {
  /** Read filter (SELECT/UPDATE/DELETE visibility). */
  readonly using: string;
  /** Write filter (INSERT/UPDATE row acceptance). */
  readonly check: string;
}

export function predicates(cls: PolicyClass): Predicates {
  if (cls === "org_only") {
    const p = `${BYPASS} OR (org_id = ${ORG})`;
    return { using: p, check: p };
  }
  if (cls === "workspace_nullable") {
    return {
      using: `${BYPASS} OR (org_id = ${ORG} AND (workspace_id IS NULL OR ${ORG_WIDE} OR workspace_id = ${WS}))`,
      check: `${BYPASS} OR (org_id = ${ORG} AND (workspace_id IS NULL OR workspace_id = ${WS}))`,
    };
  }
  if (cls === "workspace_only") {
    // Membership/join tables that carry workspace_id but no org_id. There is
    // no org column to fence the org-wide read with, so `app.org_wide` alone
    // would open the table to every tenant. It gets no org-wide disjunct:
    // an organisation-wide read of a workspace_only table has to reach it
    // through the org-scoped parent it hangs off.
    const p = `${BYPASS} OR (workspace_id = ${WS})`;
    return { using: p, check: p };
  }
  if (cls === "org_or_global") {
    // Nullable org_id: NULL rows are a shared/global catalog. This is the ONE
    // class where USING ≠ WITH CHECK:
    //   • READS  (USING): own-org rows + the global (NULL) catalog.
    //   • WRITES (CHECK): own-org rows ONLY. Creating/altering a global (NULL)
    //     row is reserved for the seeding/system path (app.rls_bypass='on').
    // A symmetric predicate would let any tenant INSERT org_id=NULL and publish
    // a platform-wide registry entry visible to everyone (SSRF / supply-chain).
    return {
      using: `${BYPASS} OR (org_id IS NULL OR org_id = ${ORG})`,
      check: `${BYPASS} OR (org_id = ${ORG})`,
    };
  }
  // standard: org_id + workspace_id both required
  return {
    using: `${BYPASS} OR (org_id = ${ORG} AND (${ORG_WIDE} OR workspace_id = ${WS}))`,
    check: `${BYPASS} OR (org_id = ${ORG} AND workspace_id = ${WS})`,
  };
}

const DEFAULT_OUT_NAME = "20260612140000_restore_rls_policies.sql";
const OUT_NAME_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

export interface Selection {
  /** The manifest entries the migration carries. */
  readonly entries: readonly PolicyEntry[];
  /** The `--only=` argument as given, or null when absent. */
  readonly onlyArg: string | null;
  /** The migration file name. */
  readonly outName: string;
}

/**
 * Reads the CLI arguments against the manifest. Throws on an empty `--only=`,
 * on a table `--only` names that the manifest does not, and on a file name
 * that is not an Atlas migration name, so no file is written for a run that
 * would emit the wrong DDL or land outside the migration order.
 */
export function selectEntries(
  manifest: readonly PolicyEntry[],
  args: readonly string[],
): Selection {
  const onlyArg = args.find((a) => a.startsWith("--only=")) ?? null;
  const outName = args.find((a) => !a.startsWith("--")) ?? DEFAULT_OUT_NAME;
  if (!OUT_NAME_PATTERN.test(outName)) {
    throw new Error(
      `refusing to write "${outName}" — Atlas migration names must match <14-digit-timestamp>_<slug>.sql`,
    );
  }
  if (onlyArg === null) return { entries: manifest, onlyArg, outName };
  const only = new Set(
    onlyArg
      .slice("--only=".length)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  if (only.size === 0) throw new Error("--only= names no table");
  const known = new Set(manifest.map((e) => e.table));
  const unknown = [...only].filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `--only names tables that are not in POLICY_MANIFEST: ${unknown.join(", ")}`,
    );
  }
  return {
    entries: manifest.filter((e) => only.has(e.table)),
    onlyArg,
    outName,
  };
}

export function renderMigration({
  entries,
  onlyArg,
  outName,
}: Selection): string {
  const blocks = entries.map(({ table, policyClass }) => {
    const { using, check } = predicates(policyClass);
    return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table}
  USING (${using})
  WITH CHECK (${check});`;
  });

  return `-- GENERATED by tools/scripts/gen-rls-migration.ts — do not edit by hand.
-- Re-generate with: pnpm tsx tools/scripts/gen-rls-migration.ts ${outName}${onlyArg ? ` ${onlyArg}` : ""}
-- then: cd packages/database && pnpm exec atlas migrate hash
--
-- Restore tenant + workspace RLS lost in the 2026-06-11 Atlas re-baseline
-- (OXA-1700; original design OXA-1515). \`drizzle-kit export\` emits only the
-- Drizzle-modeled schema, so policy DDL must live as a versioned migration in
-- this directory to survive rebuilds — exactly like the oxagen_app regrant.
--
-- Bypass-aware: app.rls_bypass='on' (set by withSystemDb / the seeding window
-- when TENANT_RLS_ENFORCEMENT_ENABLED=false) disables filtering; tenant
-- sessions get app.current_org_id / app.current_workspace_id via withTenantDb.
--
-- Org-wide-aware (ADR-075): app.org_wide='on', set by withOrgDb and nothing
-- else, widens the READ of an org-scoped table to every workspace in the
-- organisation while the org fence still holds. It is absent from WITH CHECK,
-- so writes stay pinned to the workspace in scope, and absent from
-- workspace_only tables, which have no org column to fence with.
-- FORCE applies policies to the table owner too; only superusers and
-- BYPASSRLS roles are exempt — oxagen_app is neither.
-- ${entries.length} of ${POLICY_MANIFEST.length} manifest tables${onlyArg ? ` (${onlyArg})` : ""}.

${blocks.join("\n\n")}
`;
}

function main(): void {
  let selection: Selection;
  try {
    selection = selectEntries(POLICY_MANIFEST, process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const outPath = resolve(
    __dirname,
    "../../packages/database/atlas/migrations",
    selection.outName,
  );
  writeFileSync(outPath, renderMigration(selection), "utf8");
  console.log(
    `wrote ${outPath} (${selection.entries.length} tables) — now run: cd packages/database && pnpm exec atlas migrate hash`,
  );
}

// tsx sets argv[1] to the script path; a test importing the module must not
// write a migration.
if (process.argv[1] && resolve(process.argv[1]) === __filename) main();
