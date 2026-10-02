// run-work-order-claims.test.ts — the work order claims a wrapped run's frames
// carry (F13, #4638), against a mocked ClickHouse client.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface QueryCall {
  query: string;
  query_params: Record<string, unknown>;
  clickhouse_settings?: unknown;
}

const queryMock = vi.fn<(args: QueryCall) => Promise<{ json: () => Promise<unknown[]> }>>();

vi.mock("./clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clickhouse")>();
  return { ...actual, clickhouse: () => ({ query: queryMock }) };
});

import { COST_FRAME_QUERY_SETTINGS } from "./cost-frames";
import {
  CLAIMED_WORK_ORDER_ATTR,
  RUN_WORK_ORDER_CLAIM_LIMIT,
  WORK_ORDER_ATTR,
  readRunWorkOrderClaims,
} from "./run-work-order-claims";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const ROOT = "00000000-0000-4000-8000-0000000000aa";
const CHILD = "00000000-0000-4000-8000-0000000000cc";

function answer(rows: unknown[]): void {
  queryMock.mockResolvedValueOnce({ json: async () => rows });
}

function lastQuery(): QueryCall {
  return queryMock.mock.calls.at(-1)![0];
}

describe("readRunWorkOrderClaims", () => {
  beforeEach(() => queryMock.mockReset());

  it("names the attribute the launch sets and the claim the daemon re-keys it to", () => {
    expect(WORK_ORDER_ATTR).toBe("oxagen.work_order.id");
    expect(CLAIMED_WORK_ORDER_ATTR).toBe("client_claimed.oxagen.work_order.id");
  });

  it("reads the run's own chains by the table's sort key and both spellings", async () => {
    answer([{ claim: "wo_first" }, { claim: "wo_second" }]);
    const claims = await readRunWorkOrderClaims({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: ROOT,
      sessionUuids: [CHILD],
    });
    expect(claims).toEqual(["wo_first", "wo_second"]);
    const call = lastQuery();
    expect(call.query).toContain("FROM tacho_events FINAL");
    expect(call.query).toContain("org_id = {orgId:UUID}");
    expect(call.query).toContain("workspace_id = {workspaceId:UUID}");
    expect(call.query).toContain("root_session_uuid = {rootSessionUuid:UUID}");
    expect(call.query).toContain("session_uuid IN {sessionUuids:Array(UUID)}");
    expect(call.query).toContain("ORDER BY first_at");
    expect(call.query_params).toMatchObject({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: ROOT,
      // The root is always read, first.
      sessionUuids: [ROOT, CHILD],
      attr: WORK_ORDER_ATTR,
      claimedAttr: CLAIMED_WORK_ORDER_ATTR,
      limit: RUN_WORK_ORDER_CLAIM_LIMIT,
    });
    expect(call.clickhouse_settings).toEqual(COST_FRAME_QUERY_SETTINGS);
  });

  it("keeps the session list as given when it already holds the root", async () => {
    answer([]);
    await readRunWorkOrderClaims({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: ROOT,
      sessionUuids: [ROOT, CHILD],
    });
    expect(lastQuery().query_params.sessionUuids).toEqual([ROOT, CHILD]);
  });

  it("returns no claims for a run whose frames name no work order", async () => {
    answer([]);
    await expect(
      readRunWorkOrderClaims({ orgId: ORG, workspaceId: WS, rootSessionUuid: ROOT, sessionUuids: [ROOT] }),
    ).resolves.toEqual([]);
  });

  it("drops a blank claim and trims the rest", async () => {
    answer([{ claim: "  " }, { claim: " wo_padded " }]);
    await expect(
      readRunWorkOrderClaims({ orgId: ORG, workspaceId: WS, rootSessionUuid: ROOT, sessionUuids: [ROOT] }),
    ).resolves.toEqual(["wo_padded"]);
  });

  it("throws when the store is degraded, so the rollup retries", async () => {
    queryMock.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      readRunWorkOrderClaims({ orgId: ORG, workspaceId: WS, rootSessionUuid: ROOT, sessionUuids: [ROOT] }),
    ).rejects.toThrow("clickhouse down");
  });
});
