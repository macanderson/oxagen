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

import { shellNavCountsGetHandler } from "./shell.nav_counts.get";
import { makeCTX } from "./test-utils/fixtures";

const dialect = new PgDialect();

function tx(pending: number, captured: { where: string | null }) {
  return {
    select: () => ({
      from: () => ({
        where: (cond: SQL) => {
          captured.where = dialect.sqlToQuery(cond).sql;
          return Promise.resolve([{ pending }]);
        },
      }),
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("get_nav_counts", () => {
  it("counts the workspace's pending, unexpired approvals and leaves the absent stores null", async () => {
    const captured = { where: null as string | null };
    mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
      Promise.resolve(fn(tx(3, captured))),
    );
    const out = await shellNavCountsGetHandler({}, makeCTX());
    expect(out).toEqual({ approvals: 3, proposals: null, incidents: null });
    expect(captured.where).toMatch(/"org_id" = \$/);
    expect(captured.where).toMatch(/"workspace_id" = \$/);
    expect(captured.where).toMatch(/"resolution" is null/);
    expect(captured.where).toMatch(/"expires_at" > now\(\)/);
  });

  it("answers zero, never null, for a workspace with nothing pending (negative)", async () => {
    mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
      Promise.resolve(fn(tx(0, { where: null }))),
    );
    const out = await shellNavCountsGetHandler({}, makeCTX());
    expect(out.approvals).toBe(0);
  });

  it("answers null, never a fabricated zero, when the count read returns no row (negative)", async () => {
    mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
      Promise.resolve(
        fn({
          select: () => ({
            from: () => ({ where: () => Promise.resolve([]) }),
          }),
        }),
      ),
    );
    const out = await shellNavCountsGetHandler({}, makeCTX());
    expect(out).toEqual({ approvals: null, proposals: null, incidents: null });
  });
});
