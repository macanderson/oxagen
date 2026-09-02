import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  inngestSend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("./event-client", () => ({ eventClient: { send: mocks.inngestSend } }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { repoSyncHandler } from "./repo.sync";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

type Row = {
  id: string;
  deliveryMethod: string | null;
  deliveryConfig: Record<string, unknown> | null;
  status: string;
  entityCount: number;
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

function makeRow(over: Partial<NonNullable<Row>> = {}): NonNullable<Row> {
  return {
    id: "uuid-repo-1",
    deliveryMethod: "webhook",
    deliveryConfig: null,
    status: "connected",
    entityCount: 250,
    ...over,
  };
}

describe("repo.sync handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inngestSend.mockResolvedValue(undefined);
  });

  it("throws 404 when the repository connection does not exist", async () => {
    setup(null);
    await expect(
      repoSyncHandler({ repoId: "con_missing", mode: "incremental" }, CTX),
    ).rejects.toThrow("Repository connection not found");
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("rejects syncing a connection that is being deleted (409)", async () => {
    setup(makeRow({ status: "deleting" }));
    await expect(
      repoSyncHandler({ repoId: "con_1", mode: "full" }, CTX),
    ).rejects.toThrow(/cannot sync a connection being deleted/);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("queues an ingestion/sync.requested event with the real connection UUID", async () => {
    setup(
      makeRow({
        deliveryConfig: { syncMethod: "polling", syncIntervalSeconds: 600 },
      }),
    );
    const out = await repoSyncHandler(
      { repoId: "con_1", mode: "incremental" },
      CTX,
    );

    expect(out.status).toBe("queued");
    expect(out.mode).toBe("incremental");
    expect(typeof out.jobId).toBe("string");
    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    const [event] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(event["name"]).toBe("ingestion/sync.requested");
    const data = event["data"] as Record<string, unknown>;
    expect(data["connectionId"]).toBe("uuid-repo-1");
    expect(data["integrationId"]).toBe("con_1");
    expect(data["syncMethod"]).toBe("polling");
    expect(data["syncIntervalSeconds"]).toBe(600);
  });

  it("estimates entityCount records for a full re-index and 0 for incremental", async () => {
    setup(makeRow({ entityCount: 250 }));
    const full = await repoSyncHandler({ repoId: "con_1", mode: "full" }, CTX);
    expect(full.estimatedRecords).toBe(250);

    setup(makeRow({ entityCount: 250 }));
    const incremental = await repoSyncHandler(
      { repoId: "con_1", mode: "incremental" },
      CTX,
    );
    expect(incremental.estimatedRecords).toBe(0);
  });

  it("falls back to the connection deliveryMethod when deliveryConfig has no syncMethod", async () => {
    setup(makeRow({ deliveryConfig: null, deliveryMethod: "rest_polling" }));
    await repoSyncHandler({ repoId: "con_1", mode: "incremental" }, CTX);
    const [event] = mocks.inngestSend.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect((event["data"] as Record<string, unknown>)["syncMethod"]).toBe(
      "rest_polling",
    );
  });
});
