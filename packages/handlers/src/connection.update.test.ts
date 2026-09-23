import { PgDialect } from "drizzle-orm/pg-core";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { connectionUpdateHandler } from "./connection.update";
import { TEST_CTX } from "./test-utils/fixtures";

type Row = {
  publicId: string;
  displayName: string;
  status: string;
  deliveryConfig: unknown;
} | null;

function setup(row: Row, setSpy = vi.fn()) {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({
          set: (v: unknown) => {
            setSpy(v);
            return { where: () => Promise.resolve() };
          },
        }),
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }),
          }),
        }),
      }),
  );
  return { setSpy };
}

describe("connection.update handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renames a connection and returns the row", async () => {
    setup({
      publicId: "con_1",
      displayName: "New name",
      status: "connected",
      deliveryConfig: { a: 1 },
    });
    const out = await connectionUpdateHandler(
      { connectionId: "con_1", displayName: "New name" },
      TEST_CTX,
    );
    expect(out).toEqual({
      connectionId: "con_1",
      displayName: "New name",
      status: "connected",
      deliveryConfig: { a: 1 },
    });
  });

  it("passes the new deliveryConfig to the update", async () => {
    const { setSpy } = setup({
      publicId: "con_1",
      displayName: "n",
      status: "connected",
      deliveryConfig: { x: 2 },
    });
    await connectionUpdateHandler(
      { connectionId: "con_1", deliveryConfig: { x: 2 } },
      TEST_CTX,
    );
    const query = new PgDialect().sqlToQuery(
      setSpy.mock.calls[0]?.[0].deliveryConfig,
    );
    expect(query.sql).toContain("runOutcomesOnly");
    expect(query.sql).toContain("CASE WHEN");
    expect(query.params).toEqual([
      JSON.stringify({ x: 2 }),
      JSON.stringify({ x: 2 }),
    ]);
  });

  it("throws 404 when the connection does not exist", async () => {
    setup(null);
    await expect(
      connectionUpdateHandler(
        { connectionId: "con_missing", displayName: "x" },
        TEST_CTX,
      ),
    ).rejects.toThrow("Connection not found");
  });
});

it("preserves the issue-only marker when replacement configuration is null", async () => {
  const { setSpy } = setup({
    publicId: "con_1",
    displayName: "Issues",
    status: "connected",
    deliveryConfig: { runOutcomesOnly: true },
  });
  await connectionUpdateHandler(
    { connectionId: "con_1", deliveryConfig: null },
    TEST_CTX,
  );
  const query = new PgDialect().sqlToQuery(
    setSpy.mock.calls[0]?.[0].deliveryConfig,
  );
  expect(query.params).toEqual(["{}", null]);
  expect(query.sql).toContain(`'{"runOutcomesOnly":true}'::jsonb`);
});
