import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { integrationMetricsHandler } from "./integration.metrics";
import { TEST_CTX } from "./test-utils/fixtures";

type Row = {
  publicId: string;
  connectorId: string;
  displayName: string;
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

describe("integration.metrics handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports an active connection with real entity count and last sync", async () => {
    setup({
      publicId: "con_active",
      connectorId: "github",
      displayName: "Acme GitHub",
      status: "connected",
      entityCount: 1432,
      lastSyncAt: SYNCED_AT,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });

    const out = await integrationMetricsHandler(
      { integrationId: "con_active" },
      TEST_CTX,
    );

    expect(out).toEqual({
      integrationId: "con_active",
      pluginId: "github",
      displayName: "Acme GitHub",
      status: "active",
      entityCount: 1432,
      entityCountByType: {},
      lastSyncAt: SYNCED_AT.toISOString(),
      lastSyncDurationMs: null,
      lastErrorAt: null,
      errorMessage: null,
    });
  });

  it("reports a pending_setup connection with real zeros and nulls", async () => {
    setup({
      publicId: "con_pending",
      connectorId: "notion",
      displayName: "Pending Notion",
      status: "pending_setup",
      entityCount: 0,
      lastSyncAt: null,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });

    const out = await integrationMetricsHandler(
      { integrationId: "con_pending" },
      TEST_CTX,
    );

    expect(out.status).toBe("pending_setup");
    expect(out.entityCount).toBe(0);
    expect(out.entityCountByType).toEqual({});
    expect(out.lastSyncAt).toBeNull();
    expect(out.lastSyncDurationMs).toBeNull();
    expect(out.lastErrorAt).toBeNull();
    expect(out.errorMessage).toBeNull();
    expect(out.pluginId).toBe("notion");
  });

  it("maps error status to failed and surfaces the error with updatedAt as lastErrorAt proxy", async () => {
    setup({
      publicId: "con_broken",
      connectorId: "slack",
      displayName: "Broken Slack",
      status: "error",
      entityCount: 12,
      lastSyncAt: SYNCED_AT,
      errorMessage: "token expired",
      updatedAt: UPDATED_AT,
    });

    const out = await integrationMetricsHandler(
      { integrationId: "con_broken" },
      TEST_CTX,
    );

    expect(out.status).toBe("failed");
    expect(out.errorMessage).toBe("token expired");
    expect(out.lastErrorAt).toBe(UPDATED_AT.toISOString());
    expect(out.lastSyncAt).toBe(SYNCED_AT.toISOString());
  });

  it("does not report a lastErrorAt when status is error but there is no error message", async () => {
    setup({
      publicId: "con_quiet",
      connectorId: "linear",
      displayName: "Quiet Linear",
      status: "error",
      entityCount: 3,
      lastSyncAt: SYNCED_AT,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });

    const out = await integrationMetricsHandler(
      { integrationId: "con_quiet" },
      TEST_CTX,
    );

    expect(out.status).toBe("failed");
    expect(out.errorMessage).toBeNull();
    expect(out.lastErrorAt).toBeNull();
  });

  it("maps a paused connection to paused without an error", async () => {
    setup({
      publicId: "con_paused",
      connectorId: "jira",
      displayName: "Paused Jira",
      status: "paused",
      entityCount: 88,
      lastSyncAt: SYNCED_AT,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });

    const out = await integrationMetricsHandler(
      { integrationId: "con_paused" },
      TEST_CTX,
    );

    expect(out.status).toBe("paused");
    expect(out.entityCount).toBe(88);
    expect(out.lastErrorAt).toBeNull();
  });

  it("collapses deleting/deleted connections to pending_setup", async () => {
    setup({
      publicId: "con_deleting",
      connectorId: "asana",
      displayName: "Deleting Asana",
      status: "deleting",
      entityCount: 5,
      lastSyncAt: SYNCED_AT,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });

    const out = await integrationMetricsHandler(
      { integrationId: "con_deleting" },
      TEST_CTX,
    );

    expect(out.status).toBe("pending_setup");
  });

  it("throws not-found when the integration does not exist", async () => {
    setup(null);

    await expect(
      integrationMetricsHandler({ integrationId: "con_missing" }, TEST_CTX),
    ).rejects.toThrow(
      "integration.metrics: integration not found: con_missing",
    );
  });

  it("routes the query through withTenantDb for tenant scoping", async () => {
    setup({
      publicId: "con_scope",
      connectorId: "github",
      displayName: "Scoped",
      status: "connected",
      entityCount: 1,
      lastSyncAt: null,
      errorMessage: null,
      updatedAt: UPDATED_AT,
    });

    await integrationMetricsHandler({ integrationId: "con_scope" }, TEST_CTX);

    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});
