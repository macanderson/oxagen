import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  loadBuiltInSchema: vi.fn(),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/ingestion/connector-schema-loader", () => ({
  loadBuiltInSchema: mocks.loadBuiltInSchema,
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { integrationGetHandler } from "./integration.get";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

type Row = {
  publicId: string;
  connectorId: string;
  displayName: string;
  status: string;
  deliveryConfig: Record<string, unknown> | null;
  entityCount: number;
  lastSyncAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
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

const CREATED = new Date("2026-06-18T08:00:00.000Z");
const UPDATED = new Date("2026-06-19T08:00:00.000Z");

describe("integration.get handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns full detail with the bundled connector schema and real version", async () => {
    mocks.loadBuiltInSchema.mockReturnValue({
      metadata: { version: "2.1.0" },
      config: { fields: [] },
    });
    setup({
      publicId: "con_a",
      connectorId: "github",
      displayName: "Acme GitHub",
      status: "connected",
      deliveryConfig: { owner: "acme" },
      entityCount: 42,
      lastSyncAt: null,
      errorMessage: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });

    const out = await integrationGetHandler({ integrationId: "con_a" }, CTX);

    expect(out.id).toBe("con_a");
    expect(out.pluginId).toBe("github");
    expect(out.status).toBe("active");
    expect(out.version).toBe("2.1.0");
    expect(out.config).toEqual({ owner: "acme" });
    expect(out.schema).toEqual({
      metadata: { version: "2.1.0" },
      config: { fields: [] },
    });
    expect(out.entityCount).toBe(42);
    expect(out.createdAt).toBe(CREATED.toISOString());
    expect(out.updatedAt).toBe(UPDATED.toISOString());
  });

  it("returns a null schema for a connector with no bundled schema", async () => {
    mocks.loadBuiltInSchema.mockReturnValue(null);
    setup({
      publicId: "con_b",
      connectorId: "custom-webhook",
      displayName: "Custom",
      status: "pending_setup",
      deliveryConfig: null,
      entityCount: 0,
      lastSyncAt: null,
      errorMessage: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });

    const out = await integrationGetHandler({ integrationId: "con_b" }, CTX);
    expect(out.schema).toBeNull();
    expect(out.config).toEqual({});
    expect(out.status).toBe("pending_setup");
  });

  it("maps error status to failed and surfaces the error message", async () => {
    mocks.loadBuiltInSchema.mockReturnValue(null);
    setup({
      publicId: "con_e",
      connectorId: "linear",
      displayName: "Broken Linear",
      status: "error",
      deliveryConfig: null,
      entityCount: 2,
      lastSyncAt: null,
      errorMessage: "token expired",
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
    const out = await integrationGetHandler({ integrationId: "con_e" }, CTX);
    expect(out.status).toBe("failed");
    expect(out.errorMessage).toBe("token expired");
  });

  it("throws 404 when the integration does not exist", async () => {
    mocks.loadBuiltInSchema.mockReturnValue(null);
    setup(null);
    await expect(
      integrationGetHandler({ integrationId: "con_missing" }, CTX),
    ).rejects.toThrow("Integration not found");
  });
});
