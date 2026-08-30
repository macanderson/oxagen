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

import { repoMetricsHandler } from "./repo.metrics";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

type Row = {
  publicId: string;
  displayName: string;
  deliveryMethod: string | null;
  deliveryConfig: Record<string, unknown> | null;
  status: string;
  entityCount: number;
  lastSyncAt: Date | null;
  errorMessage: string | null;
  updatedAt: Date;
} | null;

function setup(row: Row) {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }),
          }),
        }),
      }),
  );
}

const SYNCED_AT = new Date("2026-06-19T10:00:00.000Z");
const UPDATED_AT = new Date("2026-06-19T12:30:00.000Z");

describe("repo.metrics handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports an active polling connection with interval and estimated next sync", async () => {
    setup({
      publicId: "con_active",
      displayName: "acme/app",
      deliveryMethod: "rest_polling",
      deliveryConfig: { syncMethod: "polling", syncIntervalSeconds: 600 },
      status: "connected",
      entityCount: 1432,
      lastSyncAt: SYNCED_AT,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });

    const out = await repoMetricsHandler({ repoId: "con_active" }, CTX);

    expect(out.repoId).toBe("con_active");
    expect(out.displayName).toBe("acme/app");
    expect(out.status).toBe("active");
    expect(out.entityCount).toBe(1432);
    expect(out.entityCountByType).toEqual({});
    expect(out.lastSyncAt).toBe(SYNCED_AT.toISOString());
    expect(out.lastSyncDurationMs).toBeNull();
    expect(out.syncIntervalSeconds).toBe(600);
    expect(out.estimatedNextSyncAt).toBe(
      new Date(SYNCED_AT.getTime() + 600 * 1000).toISOString(),
    );
    expect(out.lastErrorAt).toBeNull();
  });

  it("returns null interval and next-sync for a non-polling (webhook) connection", async () => {
    setup({
      publicId: "con_wh",
      displayName: "acme/app",
      deliveryMethod: "webhook",
      deliveryConfig: { syncMethod: "webhook" },
      status: "connected",
      entityCount: 10,
      lastSyncAt: SYNCED_AT,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });

    const out = await repoMetricsHandler({ repoId: "con_wh" }, CTX);
    expect(out.syncIntervalSeconds).toBeNull();
    expect(out.estimatedNextSyncAt).toBeNull();
  });

  it("maps error status to failed and surfaces updatedAt as the last-error proxy", async () => {
    setup({
      publicId: "con_broken",
      displayName: "broken",
      deliveryMethod: "webhook",
      deliveryConfig: null,
      status: "error",
      entityCount: 3,
      lastSyncAt: SYNCED_AT,
      errorMessage: "rate limited",
      updatedAt: UPDATED_AT,
    });

    const out = await repoMetricsHandler({ repoId: "con_broken" }, CTX);
    expect(out.status).toBe("failed");
    expect(out.errorMessage).toBe("rate limited");
    expect(out.lastErrorAt).toBe(UPDATED_AT.toISOString());
  });

  it("collapses a deleting connection to pending_setup with no interval/next-sync", async () => {
    setup({
      publicId: "con_del",
      displayName: "del",
      deliveryMethod: "rest_polling",
      deliveryConfig: { syncMethod: "polling", syncIntervalSeconds: 600 },
      status: "deleting",
      entityCount: 5,
      lastSyncAt: SYNCED_AT,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });
    const out = await repoMetricsHandler({ repoId: "con_del" }, CTX);
    expect(out.status).toBe("pending_setup");
    // status !== active → no next-sync estimate even for a polling connection.
    expect(out.estimatedNextSyncAt).toBeNull();
  });

  it("throws 404 when the connection does not exist", async () => {
    setup(null);
    await expect(
      repoMetricsHandler({ repoId: "con_missing" }, CTX),
    ).rejects.toThrow("Repository connection not found");
  });
});
