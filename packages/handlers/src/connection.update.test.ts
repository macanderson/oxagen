import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
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
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryConfig: { x: 2 } }),
    );
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
