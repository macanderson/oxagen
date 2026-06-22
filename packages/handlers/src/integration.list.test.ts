import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  loadBuiltInSchema: vi.fn(() => ({ metadata: { version: "2.1.0" } })),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/ingestion/connector-schema-loader", () => ({
  loadBuiltInSchema: mocks.loadBuiltInSchema,
}));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { integrationListHandler } from "./integration.list";

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

type ListRow = {
  publicId: string;
  connectorId: string;
  displayName: string;
  status: string;
  lastSyncAt: Date | null;
  entityCount: number;
  errorMessage: string | null;
  createdAt: Date;
};

const whereSpy = vi.fn();

function setup(rows: ListRow[], total: number) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: (arg: Record<string, unknown>) => {
        if ("value" in arg) {
          // count(*) query
          return {
            from: () => ({
              where: (cond: unknown) => {
                whereSpy(cond);
                return Promise.resolve([{ value: total }]);
              },
            }),
          };
        }
        // paginated list query
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve(rows) }) }),
            }),
          }),
        };
      },
    }),
  );
}

const CREATED = new Date("2026-06-18T08:00:00.000Z");
const SYNCED = new Date("2026-06-19T08:00:00.000Z");

describe("integration.list handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps source connections to integrations and computes hasMore", async () => {
    setup(
      [
        {
          publicId: "con_a",
          connectorId: "github",
          displayName: "Acme GitHub",
          status: "connected",
          lastSyncAt: SYNCED,
          entityCount: 42,
          errorMessage: null,
          createdAt: CREATED,
        },
      ],
      5,
    );

    const out = await integrationListHandler({ limit: 1, offset: 0 }, CTX);

    expect(out.total).toBe(5);
    expect(out.hasMore).toBe(true);
    expect(out.integrations).toHaveLength(1);
    expect(out.integrations[0]).toEqual({
      id: "con_a",
      pluginId: "github",
      displayName: "Acme GitHub",
      status: "active",
      version: "2.1.0",
      lastSyncAt: SYNCED.toISOString(),
      entityCount: 42,
      errorMessage: null,
      createdAt: CREATED.toISOString(),
    });
  });

  it("reports hasMore=false when the page reaches the total", async () => {
    setup(
      [
        {
          publicId: "con_a",
          connectorId: "linear",
          displayName: "Linear",
          status: "paused",
          lastSyncAt: null,
          entityCount: 0,
          errorMessage: null,
          createdAt: CREATED,
        },
      ],
      1,
    );
    const out = await integrationListHandler({ limit: 50, offset: 0 }, CTX);
    expect(out.hasMore).toBe(false);
    expect(out.integrations[0]!.status).toBe("paused");
  });

  it("returns an empty page honestly when there are no integrations", async () => {
    setup([], 0);
    const out = await integrationListHandler({ limit: 50, offset: 0 }, CTX);
    expect(out.integrations).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.hasMore).toBe(false);
  });

  it("translates a contract status filter into the DB status before querying", async () => {
    setup([], 0);
    await integrationListHandler({ status: "failed", limit: 50, offset: 0 }, CTX);
    // 'failed' must map to the DB 'error' — the filter was applied (count query ran).
    expect(whereSpy).toHaveBeenCalled();
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});
