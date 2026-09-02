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

import { repoResumeHandler } from "./repo.resume";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

type Existing = {
  id: string;
  status: string;
  deliveryMethod: string | null;
  deliveryConfig: Record<string, unknown> | null;
} | null;

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

describe("repo.resume handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resumes a paused connection to active with no nextSyncAt for webhook delivery", async () => {
    const { setSpy } = setup({
      id: "c1",
      status: "paused",
      deliveryMethod: "webhook",
      deliveryConfig: null,
    });
    const out = await repoResumeHandler({ repoId: "con_1" }, CTX);
    expect(out.status).toBe("active");
    expect(out.nextSyncAt).toBeNull();
    expect(() => new Date(out.resumedAt).toISOString()).not.toThrow();
    // DB status is the live 'connected' even though the contract exposes 'active'.
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "connected" }),
    );
  });

  it("computes nextSyncAt for a polling connection", async () => {
    setup({
      id: "c1",
      status: "paused",
      deliveryMethod: "rest_polling",
      deliveryConfig: { syncMethod: "polling", syncIntervalSeconds: 900 },
    });
    const out = await repoResumeHandler({ repoId: "con_1" }, CTX);
    expect(out.nextSyncAt).not.toBeNull();
    const delta =
      new Date(out.nextSyncAt!).getTime() - new Date(out.resumedAt).getTime();
    expect(delta).toBe(900 * 1000);
  });

  it("is idempotent when resuming an already-connected connection", async () => {
    setup({
      id: "c1",
      status: "connected",
      deliveryMethod: "webhook",
      deliveryConfig: null,
    });
    const out = await repoResumeHandler({ repoId: "con_1" }, CTX);
    expect(out.status).toBe("active");
    expect(out.nextSyncAt).toBeNull();
  });

  it("rejects resuming a connection in the error state (409)", async () => {
    setup({
      id: "c1",
      status: "error",
      deliveryMethod: "webhook",
      deliveryConfig: null,
    });
    await expect(repoResumeHandler({ repoId: "con_1" }, CTX)).rejects.toThrow(
      /only paused\/connected/,
    );
  });

  it("throws 404 when the connection does not exist", async () => {
    setup(null);
    await expect(
      repoResumeHandler({ repoId: "con_missing" }, CTX),
    ).rejects.toThrow("Repository connection not found");
  });
});
