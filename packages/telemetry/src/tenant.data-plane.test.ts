// tenant.data-plane.test.ts — chInsert / chSelect against the ADR-042 seam.
//
// Invariants:
//   1. Default (no resolver) → the shared ClickHouse singleton.
//   2. A dedicated binding routes the insert/query to the organisation's own
//      client, keyed by (orgId, configDigest), and STILL stamps the scope.
//   3. A degraded/disabled plane throws DataPlaneUnavailableError and writes
//      nowhere — misfiling a tenant's traces into another operator's store is
//      worse than dropping them.
//   4. The org_id read guard fires BEFORE any plane is resolved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sharedInsert: vi.fn(async () => undefined),
  sharedQuery: vi.fn(async () => ({ json: async () => ({ data: [] }) })),
  dedicatedInsert: vi.fn(async () => undefined),
  dedicatedQuery: vi.fn(async () => ({ json: async () => ({ data: [] }) })),
  dedicatedFactory: vi.fn(),
}));

vi.mock("./clickhouse", () => ({
  clickhouse: () => ({ insert: mocks.sharedInsert, query: mocks.sharedQuery }),
}));
vi.mock("./data-plane-client", () => ({
  dedicatedClickhouse: (args: unknown) => {
    mocks.dedicatedFactory(args);
    return { insert: mocks.dedicatedInsert, query: mocks.dedicatedQuery };
  },
}));

import {
  clearDataPlaneResolver,
  DataPlaneUnavailableError,
  runInTenantScope,
  setDataPlaneResolver,
  type DataPlaneStatus,
} from "@oxagen/tenancy";
import { chInsert, chSelect } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";
const CH_CONFIG = {
  url: "https://ch.acme.example:8443",
  username: "acme",
  password: "s3cret",
  database: "acme_events",
};

beforeEach(() => {
  mocks.sharedInsert.mockClear();
  mocks.sharedQuery.mockClear();
  mocks.dedicatedInsert.mockClear();
  mocks.dedicatedQuery.mockClear();
  mocks.dedicatedFactory.mockClear();
});

afterEach(() => clearDataPlaneResolver());

describe("shared plane (default)", () => {
  it("inserts through the process singleton", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chInsert("events", [{ event_type: "x" }]),
    );
    expect(mocks.sharedInsert).toHaveBeenCalledTimes(1);
    expect(mocks.dedicatedFactory).not.toHaveBeenCalled();
  });

  it("queries through the process singleton", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chSelect({ query: "SELECT 1 WHERE org_id = {orgId:UUID}" }),
    );
    expect(mocks.sharedQuery).toHaveBeenCalledTimes(1);
  });
});

describe("dedicated plane", () => {
  beforeEach(() => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "dedicated",
      status: "active",
      config: CH_CONFIG,
      configDigest: "digest-1",
    }));
  });

  it("routes the insert to the organisation's own client and still stamps scope", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chInsert("events", [{ event_type: "x" }]),
    );
    expect(mocks.dedicatedFactory).toHaveBeenCalledWith({
      orgId: ORG,
      config: CH_CONFIG,
      configDigest: "digest-1",
    });
    expect(mocks.dedicatedInsert).toHaveBeenCalledWith({
      table: "events",
      values: [{ event_type: "x", org_id: ORG, workspace_id: WS }],
      format: "JSONEachRow",
    });
    expect(mocks.sharedInsert).not.toHaveBeenCalled();
  });

  it("routes the read to the organisation's own client with the tenant params", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chSelect({ query: "SELECT 1 WHERE org_id = {orgId:UUID}" }),
    );
    expect(mocks.dedicatedQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: expect.objectContaining({ orgId: ORG, workspaceId: WS }),
      }),
    );
    expect(mocks.sharedQuery).not.toHaveBeenCalled();
  });
});

describe("fail closed", () => {
  it.each<DataPlaneStatus>(["degraded", "disabled"])(
    "chInsert throws for a %s plane and writes nowhere",
    async (status) => {
      setDataPlaneResolver(async (orgId, kind) => ({
        orgId,
        kind,
        mode: "dedicated",
        status,
        config: CH_CONFIG,
      }));
      await expect(
        runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
          chInsert("events", [{ event_type: "x" }]),
        ),
      ).rejects.toThrow(DataPlaneUnavailableError);
      expect(mocks.sharedInsert).not.toHaveBeenCalled();
      expect(mocks.dedicatedInsert).not.toHaveBeenCalled();
    },
  );

  it("chSelect throws for a disabled plane", async () => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "shared",
      status: "disabled",
    }));
    await expect(
      runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
        chSelect({ query: "SELECT 1 WHERE org_id = {orgId:UUID}" }),
      ),
    ).rejects.toThrow(DataPlaneUnavailableError);
    expect(mocks.sharedQuery).not.toHaveBeenCalled();
  });

  it("the org_id read guard fires before any plane is resolved", async () => {
    const resolver = vi.fn();
    setDataPlaneResolver(resolver as never);
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await expect(chSelect({ query: "SELECT 1" })).rejects.toThrow(/org_id/);
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});
