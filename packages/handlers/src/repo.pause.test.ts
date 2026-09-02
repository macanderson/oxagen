import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { repoPauseHandler } from "./repo.pause";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

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

describe("repo.pause handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pauses a connected connection and returns an ISO pausedAt", async () => {
    const { setSpy } = setup({ id: "c1", status: "connected" });
    const out = await repoPauseHandler({ repoId: "con_1" }, CTX);
    expect(out.repoId).toBe("con_1");
    expect(out.status).toBe("paused");
    expect(() => new Date(out.pausedAt).toISOString()).not.toThrow();
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
  });

  it("is idempotent on an already-paused connection", async () => {
    setup({ id: "c1", status: "paused" });
    const out = await repoPauseHandler({ repoId: "con_1" }, CTX);
    expect(out.status).toBe("paused");
  });

  it("rejects pausing a pending_setup connection (409)", async () => {
    setup({ id: "c1", status: "pending_setup" });
    await expect(repoPauseHandler({ repoId: "con_1" }, CTX)).rejects.toThrow(
      /only connected\/paused/,
    );
  });

  it("throws 404 when the connection does not exist", async () => {
    setup(null);
    await expect(
      repoPauseHandler({ repoId: "con_missing" }, CTX),
    ).rejects.toThrow("Repository connection not found");
  });
});
