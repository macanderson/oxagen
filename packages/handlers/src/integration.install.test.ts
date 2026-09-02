import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  getConnector: vi.fn(),
  valuesSpy: vi.fn(),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: mocks.getConnector,
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { integrationInstallHandler } from "./integration.install";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1", userId: "u-1" });

function fakeConnector(parseResult: {
  success: boolean;
  data?: unknown;
  error?: unknown;
}) {
  return {
    connectorId: "github",
    deliveryMethod: "webhook",
    supportedAuthSchemes: ["oauth2_authorization_code"],
    connectionConfigSchema: { safeParse: vi.fn().mockReturnValue(parseResult) },
  };
}

function setupInsert(publicId = "con_new", id = "uuid-new") {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: () => ({
          values: (v: unknown) => {
            mocks.valuesSpy(v);
            return { returning: () => Promise.resolve([{ id, publicId }]) };
          },
        }),
      }),
  );
}

describe("integration.install handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects with 401 when there is no authenticated user", async () => {
    await expect(
      integrationInstallHandler(
        { pluginId: "github", config: {}, displayName: "GH" },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow("requires an authenticated user");
  });

  it("returns 404 for an unknown plugin", async () => {
    mocks.getConnector.mockImplementation(() => {
      throw new Error('No connector registered for "nope"');
    });
    await expect(
      integrationInstallHandler(
        { pluginId: "nope", config: {}, displayName: "X" },
        CTX,
      ),
    ).rejects.toThrow("Unknown plugin: nope");
  });

  it("returns 422 when the config fails the connector schema", async () => {
    mocks.getConnector.mockReturnValue(
      fakeConnector({
        success: false,
        error: { issues: [{ path: ["owner"], message: "Required" }] },
      }),
    );
    await expect(
      integrationInstallHandler(
        { pluginId: "github", config: {}, displayName: "GH" },
        CTX,
      ),
    ).rejects.toThrow(/Invalid plugin config: owner: Required/);
  });

  it("creates a pending_setup connection and returns a queued job", async () => {
    mocks.getConnector.mockReturnValue(
      fakeConnector({ success: true, data: { owner: "acme", repo: "app" } }),
    );
    setupInsert("con_new", "uuid-new");

    const out = await integrationInstallHandler(
      {
        pluginId: "github",
        config: { owner: "acme", repo: "app" },
        displayName: "Acme GitHub",
      },
      CTX,
    );

    expect(out).toEqual({
      jobId: "job_install_con_new",
      status: "queued",
      pluginId: "github",
      displayName: "Acme GitHub",
    });

    const inserted = mocks.valuesSpy.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(inserted["status"]).toBe("pending_setup");
    expect(inserted["connectorId"]).toBe("github");
    expect(inserted["deliveryMethod"]).toBe("webhook");
    expect(inserted["authScheme"]).toBe("oauth2_authorization_code");
    expect(inserted["deliveryConfig"]).toEqual({ owner: "acme", repo: "app" });
    expect(inserted["orgId"]).toBe("org-1");
    expect(inserted["workspaceId"]).toBe("ws-1");
  });
});
