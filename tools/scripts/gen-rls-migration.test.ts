/**
 * The `--only=` guard on the RLS migration generator.
 *
 * A follow-up migration for newly manifested tables must carry those tables'
 * DDL alone: re-emitting every manifest table would reset a live policy that
 * was hand-tuned after the manifest run. The guard refuses a filter that names
 * nothing, or a table the manifest does not know, before any file is written.
 */
import { describe, expect, it } from "vitest";
import type { PolicyEntry } from "../../packages/database/src/tenant-policy.manifest.js";
import { renderMigration, selectEntries } from "./gen-rls-migration.js";

const MANIFEST: readonly PolicyEntry[] = [
  { table: "billing.contract_terms", policyClass: "org_only" },
  { table: "billing.gau_buckets", policyClass: "org_only" },
  { table: "billing.spend_budgets", policyClass: "workspace_nullable" },
];

const OUT = "20260914170000_rls_gau_tables.sql";

describe("selectEntries", () => {
  it("carries every manifest table when --only is absent", () => {
    const s = selectEntries(MANIFEST, [OUT]);
    expect(s.entries).toEqual(MANIFEST);
    expect(s.onlyArg).toBeNull();
    expect(s.outName).toBe(OUT);
  });

  it("carries only the named tables, in manifest order", () => {
    const s = selectEntries(MANIFEST, [
      OUT,
      "--only=billing.spend_budgets, billing.contract_terms",
    ]);
    expect(s.entries.map((e) => e.table)).toEqual([
      "billing.contract_terms",
      "billing.spend_budgets",
    ]);
  });

  it("refuses a table the manifest does not know, naming it", () => {
    expect(() =>
      selectEntries(MANIFEST, [
        OUT,
        "--only=billing.gau_buckets,billing.gau_settlements",
      ]),
    ).toThrow(/not in POLICY_MANIFEST: billing\.gau_settlements$/);
  });

  it("refuses an --only that names no table", () => {
    expect(() => selectEntries(MANIFEST, [OUT, "--only="])).toThrow(
      "--only= names no table",
    );
    expect(() => selectEntries(MANIFEST, [OUT, "--only=, ,"])).toThrow(
      "--only= names no table",
    );
  });

  it("refuses a file name outside the Atlas migration pattern", () => {
    expect(() => selectEntries(MANIFEST, ["rls_gau_tables.sql"])).toThrow(
      /Atlas migration names must match/,
    );
  });

  it("falls back to the restore_rls_policies file when no name is given", () => {
    expect(selectEntries(MANIFEST, []).outName).toBe(
      "20260612140000_restore_rls_policies.sql",
    );
  });
});

describe("renderMigration", () => {
  it("emits ENABLE, FORCE and a tenant_isolation policy per selected table and no other", () => {
    const sql = renderMigration(
      selectEntries(MANIFEST, [OUT, "--only=billing.gau_buckets"]),
    );
    expect(sql).toContain(
      "ALTER TABLE billing.gau_buckets ENABLE ROW LEVEL SECURITY;",
    );
    expect(sql).toContain(
      "ALTER TABLE billing.gau_buckets FORCE ROW LEVEL SECURITY;",
    );
    expect(sql).toContain(
      "CREATE POLICY tenant_isolation ON billing.gau_buckets",
    );
    expect(sql).not.toContain("billing.contract_terms");
    expect(sql).not.toContain("billing.spend_budgets");
  });

  it("records the exact command that regenerates the file", () => {
    const sql = renderMigration(
      selectEntries(MANIFEST, [OUT, "--only=billing.gau_buckets"]),
    );
    expect(sql).toContain(
      `pnpm tsx tools/scripts/gen-rls-migration.ts ${OUT} --only=billing.gau_buckets`,
    );
  });

  it("an org_only policy filters on org_id alone", () => {
    const sql = renderMigration(
      selectEntries(MANIFEST, [OUT, "--only=billing.contract_terms"]),
    );
    // The DDL after the generated header, which describes both settings.
    const ddl = sql.slice(sql.indexOf("ALTER TABLE"));
    expect(ddl).toMatch(
      /USING \(current_setting\('app\.rls_bypass', true\) = 'on' OR \(org_id = nullif\(current_setting\('app\.current_org_id', true\), ''\)::uuid\)\)/,
    );
    expect(ddl).not.toContain("workspace_id");
  });
});
