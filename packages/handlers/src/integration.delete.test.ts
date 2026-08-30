import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  inngestSend: vi.fn().mockResolvedValue(undefined),
  setSpy: vi.fn(),
  valuesSpy: vi.fn(),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("./event-client", () => ({ eventClient: { send: mocks.inngestSend } }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { integrationDeleteHandler } from "./integration.delete";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1", userId: "u-1" });

function setup(
  conn: { id: string; status: string } | null,
  jobPublicId = "djob_abc",
) {
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve(conn ? [conn] : []) }),
          }),
        }),
        update: () => ({
          set: (v: unknown) => {
            mocks.setSpy(v);
            return { where: () => Promise.resolve() };
          },
        }),
        insert: () => ({
          values: (v: unknown) => {
            mocks.valuesSpy(v);
            return {
              returning: () =>
                Promise.resolve([{ id: "uuid-job", publicId: jobPublicId }]),
            };
          },
        }),
      }),
  );
}

describe("integration.delete handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  it("rejects with 401 when there is no authenticated user", async () => {
    await expect(
      integrationDeleteHandler(
        { integrationId: "con_1", purgeData: false },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow("requires an authenticated user");
  });

  it("throws 404 when the integration does not exist", async () => {
    setup(null);
    await expect(
      integrationDeleteHandler(
        { integrationId: "con_missing", purgeData: false },
        CTX,
      ),
    ).rejects.toThrow("Integration not found");
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("purges to 'full' mode, flips status to deleting, and queues the deletion job", async () => {
    setup({ id: "uuid-conn", status: "connected" }, "djob_full");
    const out = await integrationDeleteHandler(
      { integrationId: "con_1", purgeData: true },
      CTX,
    );

    expect(out).toEqual({
      jobId: "djob_full",
      status: "queued",
      integrationId: "con_1",
      purgeData: true,
    });
    expect(mocks.setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleting" }),
    );
    const jobRow = mocks.valuesSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(jobRow["deleteMode"]).toBe("full");
    expect(jobRow["connectionId"]).toBe("uuid-conn");

    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    const [event] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(event["name"]).toBe("ingestion/connection.delete");
    expect((event["data"] as Record<string, unknown>)["mode"]).toBe("full");
  });

  it("uses 'connection_only' mode when purgeData is false", async () => {
    setup({ id: "uuid-conn", status: "connected" });
    await integrationDeleteHandler(
      { integrationId: "con_1", purgeData: false },
      CTX,
    );
    const jobRow = mocks.valuesSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(jobRow["deleteMode"]).toBe("connection_only");
    const [event] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect((event["data"] as Record<string, unknown>)["mode"]).toBe(
      "connection_only",
    );
  });
});
