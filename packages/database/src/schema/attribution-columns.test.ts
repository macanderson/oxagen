// Attribution columns are `<verb>_by_id` (Mission Control spec App. A.0 as
// amended 2026-09-15; ADR-077; migration 20260915230000). This test walks
// every table the Drizzle barrel exports and fails on the old spelling, so a
// lane that hand-rolls `created_by_user_id` on a new table is caught at unit
// time rather than by `atlas migrate diff` after its migration merged.
//
// Mutation check (done once by hand, 2026-09-15): renaming
// `createdById: uuid("created_by_id")` in `_mixins.ts` back to
// `uuid("created_by_user_id")` makes the first test list every table that
// spreads auditMixin().
//
// `iam.principal_role_assignments.assigned_by` and
// `ingestion.deletion_jobs.requested_by` still lack the suffix; both tables
// are being reshaped by lanes of the Mission Control spec (`granted_by_id` in
// App. A.4),
// so this test deliberately checks only the shared trio.

import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "./index";

function tables(): Array<{ name: string; columns: string[] }> {
  const out: Array<{ name: string; columns: string[] }> = [];
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object") continue;
    let cfg: ReturnType<typeof getTableConfig>;
    try {
      cfg = getTableConfig(value as PgTable);
    } catch {
      continue;
    }
    if (!Array.isArray(cfg.columns)) continue;
    out.push({
      name: `${cfg.schema ?? "public"}.${cfg.name}`,
      columns: cfg.columns.map((c) => c.name),
    });
  }
  return out;
}

describe("attribution column naming", () => {
  it("no table spells the audit trio as *_by_user_id", () => {
    const offenders = tables()
      .filter((t) =>
        t.columns.some((c) => /^(created|updated|deleted)_by_user_id$/.test(c)),
      )
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it("the audit mixins expose createdById / updatedById / deletedById", () => {
    expect(Object.keys(schema.auditMixin())).toEqual([
      "createdAt",
      "updatedAt",
      "createdById",
      "updatedById",
    ]);
    expect(Object.keys(schema.appendOnlyAuditMixin())).toEqual([
      "createdAt",
      "createdById",
    ]);
    expect(Object.keys(schema.softDeleteMixin())).toEqual([
      "deletedAt",
      "deletedById",
    ]);
  });
});
