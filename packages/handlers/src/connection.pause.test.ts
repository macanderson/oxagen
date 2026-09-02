import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { connectionPauseHandler } from "./connection.pause";
import { TEST_CTX } from "./test-utils/fixtures";

type Existing = { id: string; status: string } | null;

function setup(existing: Existing, setSpy = vi.fn()) {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(existing ? [existing] : []),
            }),
          }),
        }),
        update: () => ({
          set: (v: unknown) => {
            setSpy(v);
            return { where: () => Promise.resolve() };
          },
        }),
      }),
  );
  return { setSpy };
}

describe("connection.pause handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pauses a connected connection", async () => {
    const { setSpy } = setup({ id: "c1", status: "connected" });
    const out = await connectionPauseHandler(
      { connectionId: "con_1", paused: true },
      TEST_CTX,
    );
    expect(out).toEqual({ connectionId: "con_1", status: "paused" });
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
  });

  it("resumes a paused connection", async () => {
    setup({ id: "c1", status: "paused" });
    const out = await connectionPauseHandler(
      { connectionId: "con_1", paused: false },
      TEST_CTX,
    );
    expect(out.status).toBe("connected");
  });

  it("rejects pausing a pending_setup connection (409)", async () => {
    setup({ id: "c1", status: "pending_setup" });
    await expect(
      connectionPauseHandler({ connectionId: "con_1", paused: true }, TEST_CTX),
    ).rejects.toThrow(/only connected\/paused/);
  });

  it("throws 404 when the connection does not exist", async () => {
    setup(null);
    await expect(
      connectionPauseHandler(
        { connectionId: "con_missing", paused: true },
        TEST_CTX,
      ),
    ).rejects.toThrow("Connection not found");
  });
});
