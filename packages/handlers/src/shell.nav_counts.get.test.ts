import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { schema } from "@oxagen/database";
import { getTableName } from "drizzle-orm";
import { shellNavCountsGetHandler } from "./shell.nav_counts.get";
import { makeCTX } from "./test-utils/fixtures";

const dialect = new PgDialect();

interface Read {
  table: string;
  where: string;
  params: unknown[];
}

/**
 * A transaction that answers each count read from `answers`, keyed by table
 * name, and records the table and the WHERE clause each read used.
 */
function tx(answers: Record<string, { n: number }[]>, reads: Read[]) {
  return {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: (cond: SQL) => {
          const name = getTableName(table);
          const q = dialect.sqlToQuery(cond);
          reads.push({ table: name, where: q.sql, params: q.params });
          return Promise.resolve(answers[name] ?? []);
        },
      }),
    }),
  };
}

function run(answers: Record<string, { n: number }[]>) {
  const reads: Read[] = [];
  mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
    Promise.resolve(fn(tx(answers, reads))),
  );
  return { reads, out: shellNavCountsGetHandler({}, makeCTX()) };
}

const APPROVALS = getTableName(schema.approvalRequests);
const INTERJECTIONS = getTableName(schema.interjections);
const PROPOSALS = getTableName(schema.contextProposals);
const INCIDENTS = getTableName(schema.tachoIncidents);

beforeEach(() => vi.clearAllMocks());

describe("get_nav_counts", () => {
  it("counts this workspace's pending approvals, open questions and open proposals, and the organization's open critical incidents", async () => {
    const { reads, out } = run({
      [APPROVALS]: [{ n: 3 }],
      [INTERJECTIONS]: [{ n: 1 }],
      [PROPOSALS]: [{ n: 2 }],
      [INCIDENTS]: [{ n: 1 }],
    });
    await expect(out).resolves.toEqual({
      approvals: 3,
      interjections: 1,
      proposals: 2,
      incidents: 1,
    });
    // One tenant transaction for the workspace's three, one org-wide read for Audit.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
    expect(reads.map((r) => r.table)).toEqual([
      APPROVALS,
      INTERJECTIONS,
      PROPOSALS,
      INCIDENTS,
    ]);
    for (const r of reads) expect(r.where).toMatch(/"org_id" = \$/);
    expect(reads[0]?.where).toMatch(/"workspace_id" = \$/);
    expect(reads[1]?.where).toMatch(/"workspace_id" = \$/);
    expect(reads[2]?.where).toMatch(/"workspace_id" = \$/);
    // Audit is an organization page: its count is not narrowed to a workspace.
    expect(reads[3]?.where).not.toMatch(/"workspace_id"/);
  });

  // #3839: the placeholder answered null for every workspace, so the count
  // said "not recorded" even where the store could answer.
  it("counts interjections on the list_interjections open predicate", async () => {
    const { reads, out } = run({ [INTERJECTIONS]: [{ n: 2 }] });
    await expect(out).resolves.toMatchObject({ interjections: 2 });
    const where = reads[1]?.where ?? "";
    expect(where).toMatch(/"answered_at" is null/);
    expect(where).toMatch(/"expires_at" > now\(\)/);
  });

  it("reads approvals on the list_approvals predicate", async () => {
    const { reads, out } = run({ [APPROVALS]: [{ n: 0 }] });
    await out;
    const where = reads[0]?.where ?? "";
    expect(where).toMatch(/"resolution" is null/);
    expect(where).toMatch(/"expires_at" > now\(\)/);
  });

  it("counts a proposal as open until it merges or is rejected", async () => {
    const { reads, out } = run({ [PROPOSALS]: [{ n: 0 }] });
    await out;
    const read = reads[2];
    expect(read?.where).toMatch(/"status" not in \(\$\d+, \$\d+\)/);
    expect(read?.params).toEqual(
      expect.arrayContaining(["merged", "rejected"]),
    );
  });

  it("counts only unresolved incidents at severity 10, across the organization", async () => {
    const { reads, out } = run({ [INCIDENTS]: [{ n: 0 }] });
    await out;
    const read = reads[3];
    expect(read?.where).toMatch(/"severity" = \$/);
    expect(read?.where).toMatch(/"resolved_at" is null/);
    expect(read?.params).toContain(10);
  });

  it("answers zero, never null, for a workspace with nothing waiting (negative)", async () => {
    const { out } = run({
      [APPROVALS]: [{ n: 0 }],
      [INTERJECTIONS]: [{ n: 0 }],
      [PROPOSALS]: [{ n: 0 }],
      [INCIDENTS]: [{ n: 0 }],
    });
    await expect(out).resolves.toEqual({
      approvals: 0,
      interjections: 0,
      proposals: 0,
      incidents: 0,
    });
  });

  it("answers null, never a fabricated zero, for a read that returns no row (negative)", async () => {
    const { out } = run({ [PROPOSALS]: [{ n: 4 }] });
    await expect(out).resolves.toEqual({
      approvals: null,
      interjections: null,
      proposals: 4,
      incidents: null,
    });
  });
});
