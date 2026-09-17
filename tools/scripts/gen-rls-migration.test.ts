/**
 * The `--only=` guard on the RLS migration generator.
 *
 * A follow-up migration for newly manifested tables must carry those tables'
 * DDL alone: re-emitting every manifest table would reset a live policy that
 * was hand-tuned after the manifest run. The guard refuses a filter that names
 * nothing, or a table the manifest does not know, before any file is written.
 */
import { describe, expect, it } from "vitest";
import type {
  PolicyClass,
  PolicyEntry,
} from "../../packages/database/src/tenant-policy.manifest.js";
import {
  predicates,
  renderMigration,
  selectEntries,
} from "./gen-rls-migration.js";

const MANIFEST: readonly PolicyEntry[] = [
  { table: "billing.contract_terms", policyClass: "org_only" },
  { table: "billing.gau_buckets", policyClass: "org_only" },
  { table: "billing.spend_budgets", policyClass: "workspace_nullable" },
  { table: "agent.agents", policyClass: "standard" },
  { table: "workspace.workspace_users", policyClass: "workspace_only" },
  { table: "cost.price_entries", policyClass: "org_or_global" },
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

/**
 * THE ORG-WIDE PREDICATE IS READ-ONLY BY SHAPE.
 *
 * Postgres applies a policy's USING clause to the OLD rows of an UPDATE and of
 * a DELETE, not only to a SELECT, and WITH CHECK never runs for a DELETE. So
 * `app.org_wide` inside `tenant_isolation`'s USING would widen DELETE, not the
 * read. It lives in its own `FOR SELECT` policy instead.
 *
 * These are assertions about emitted SQL TEXT, which is what this module
 * produces; the assertion that a row is actually refused is
 * `packages/database/integration/org-only-sentinel-refusal.test.ts`, which runs
 * the DELETE against a real Postgres and reads the row count. Both are needed —
 * this one catches a generator that stops emitting the split, that one catches
 * a split that does not do what the split is for.
 */
describe("the org-wide read policy", () => {
  const ORG_WIDE = "current_setting('app.org_wide', true) = 'on'";

  /** Every class, so a sixth one has to be added here deliberately. */
  const WIDENED: readonly PolicyClass[] = ["standard", "workspace_nullable"];
  const NOT_WIDENED: readonly PolicyClass[] = [
    "org_only",
    "org_or_global",
    "workspace_only",
  ];

  it.each(WIDENED)("gives %s an org-wide FOR SELECT predicate", (cls) => {
    const p = predicates(cls);
    expect(p.orgWideRead).toContain(ORG_WIDE);
    // Fenced by org_id on its own: the policy is OR'd with tenant_isolation, so
    // anything it admits is admitted outright.
    expect(p.orgWideRead).toContain("org_id =");
  });

  it.each(NOT_WIDENED)("gives %s no org-wide predicate at all", (cls) => {
    expect(predicates(cls).orgWideRead).toBeNull();
  });

  it.each([...WIDENED, ...NOT_WIDENED])(
    "keeps %s's USING and WITH CHECK free of app.org_wide",
    (cls) => {
      const { using, check } = predicates(cls);
      expect(using).not.toContain("app.org_wide");
      expect(check).not.toContain("app.org_wide");
    },
  );

  it("emits a FOR SELECT policy for a widened table and none for an org_only one", () => {
    const widened = renderMigration(
      selectEntries(MANIFEST, [OUT, "--only=agent.agents"]),
    );
    expect(widened).toContain(
      "CREATE POLICY tenant_org_wide_read ON agent.agents",
    );
    expect(widened).toMatch(
      /CREATE POLICY tenant_org_wide_read ON agent\.agents\n  FOR SELECT\n  USING \(current_setting\('app\.org_wide', true\) = 'on' AND org_id = /,
    );

    const plain = renderMigration(
      selectEntries(MANIFEST, [OUT, "--only=billing.contract_terms"]),
    );
    expect(plain).not.toContain("CREATE POLICY tenant_org_wide_read");
  });

  it("drops the org-wide policy on every table, widened or not", () => {
    for (const table of ["agent.agents", "billing.contract_terms"]) {
      const sql = renderMigration(
        selectEntries(MANIFEST, [OUT, `--only=${table}`]),
      );
      expect(sql).toContain(
        `DROP POLICY IF EXISTS tenant_org_wide_read ON ${table};`,
      );
    }
  });

  it("never emits app.org_wide in a clause that governs a write", () => {
    const sql = renderMigration(selectEntries(MANIFEST, [OUT]));
    const ddl = sql.slice(sql.indexOf("ALTER TABLE"));
    // Every occurrence of the GUC must sit in a FOR SELECT policy body.
    const isolation = ddl
      .split("CREATE POLICY ")
      .filter((b) => b.startsWith("tenant_isolation "));
    expect(isolation.length).toBe(MANIFEST.length);
    for (const block of isolation) expect(block).not.toContain("app.org_wide");
    for (const block of ddl
      .split("CREATE POLICY ")
      .filter((b) => b.startsWith("tenant_org_wide_read "))) {
      expect(block).toContain("FOR SELECT");
      expect(block).not.toContain("WITH CHECK");
    }
  });
});
