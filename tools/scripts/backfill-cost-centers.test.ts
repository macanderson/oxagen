// The backfill loop (ADR-142) over faked stores: it pages with the last row
// as the cursor, sends one rebuild request per run only on apply, stops at
// the run cap and says so, and counts a failed page without stopping.
import { describe, expect, it, vi } from "vitest";
import type { UnassignedCostCenterRun } from "@oxagen/billing";
import { parseFlags } from "./backfill-cost-centers";
import {
  backfillCostCenters,
  RUN_SEALED_EVENT,
  type RunSealedEvent,
} from "./lib/backfill-cost-centers";

const ORG = "7a000000-0000-4000-8000-0000000000a1";
const WS = "7b000000-0000-4000-8000-000000000001";

function run(n: number): UnassignedCostCenterRun {
  return {
    runId: `tse_${String(n).padStart(3, "0")}`,
    orgId: ORG,
    workspaceId: WS,
    startedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString(),
  };
}

/** A lister over `rows` that pages after the cursor the way the store does. */
function lister(rows: UnassignedCostCenterRun[]) {
  return vi.fn(
    async (args: {
      limit: number;
      after?: UnassignedCostCenterRun;
      orgId?: string;
    }) => {
      const start =
        args.after === undefined
          ? 0
          : rows.findIndex((r) => r.runId === args.after!.runId) + 1;
      return rows.slice(start, start + args.limit);
    },
  );
}

describe("backfillCostCenters", () => {
  it("lists every run in pages and sends one request per run on apply", async () => {
    const rows = [run(1), run(2), run(3), run(4), run(5)];
    const list = lister(rows);
    const sent: RunSealedEvent[][] = [];
    const log: string[] = [];
    const report = await backfillCostCenters(
      { apply: true, pageSize: 2, maxRuns: 100 },
      {
        list,
        send: async (events) => {
          sent.push(events);
        },
        log: (line) => log.push(line),
      },
    );
    expect(report).toEqual({
      listed: 5,
      requested: 5,
      failedPages: 0,
      truncated: false,
    });
    expect(sent.map((page) => page.map((e) => e.data.runId))).toEqual([
      ["tse_001", "tse_002"],
      ["tse_003", "tse_004"],
      ["tse_005"],
    ]);
    expect(sent[0]![0]).toEqual({
      name: RUN_SEALED_EVENT,
      data: { runId: "tse_001", orgId: ORG, workspaceId: WS },
    });
    // The cursor is the last row of the page before, never the head.
    expect(list.mock.calls.map(([a]) => a.after?.runId)).toEqual([
      undefined,
      "tse_002",
      "tse_004",
      "tse_005",
    ]);
    expect(log[0]).toContain("request tse_001");
  });

  it("sends nothing on a dry run and still reports the count", async () => {
    const send = vi.fn(async () => {});
    const report = await backfillCostCenters(
      { apply: false, pageSize: 10, maxRuns: 100, orgId: ORG },
      {
        list: lister([run(1), run(2)]),
        send,
        log: () => {},
      },
    );
    expect(report).toEqual({
      listed: 2,
      requested: 0,
      failedPages: 0,
      truncated: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("passes the organization through to the lister", async () => {
    const list = lister([]);
    await backfillCostCenters(
      { apply: false, pageSize: 10, maxRuns: 100, orgId: ORG },
      { list, send: async () => {}, log: () => {} },
    );
    expect(list).toHaveBeenCalledWith({
      limit: 10,
      after: undefined,
      orgId: ORG,
    });
  });

  it("stops at the run cap and reports that more remain", async () => {
    const rows = [run(1), run(2), run(3)];
    const sent: RunSealedEvent[][] = [];
    const report = await backfillCostCenters(
      { apply: true, pageSize: 10, maxRuns: 2 },
      {
        list: lister(rows),
        send: async (events) => {
          sent.push(events);
        },
        log: () => {},
      },
    );
    expect(report).toEqual({
      listed: 2,
      requested: 2,
      failedPages: 0,
      truncated: true,
    });
    expect(sent.flat().map((e) => e.data.runId)).toEqual([
      "tse_001",
      "tse_002",
    ]);
  });

  it("counts a page whose send failed and carries on (negative)", async () => {
    const rows = [run(1), run(2), run(3), run(4)];
    let calls = 0;
    const log: string[] = [];
    const report = await backfillCostCenters(
      { apply: true, pageSize: 2, maxRuns: 100 },
      {
        list: lister(rows),
        send: async () => {
          calls += 1;
          if (calls === 1) throw new Error("event key rejected");
        },
        log: (line) => log.push(line),
      },
    );
    expect(report).toEqual({
      listed: 4,
      requested: 2,
      failedPages: 1,
      truncated: false,
    });
    expect(log).toContainEqual(
      "send failed for 2 run(s) from tse_001: event key rejected",
    );
  });
});

describe("parseFlags", () => {
  it("dry-runs every organization with the defaults when given nothing", () => {
    expect(parseFlags([])).toEqual({
      apply: false,
      pageSize: 100,
      maxRuns: 10_000,
    });
  });

  it("reads apply, the organization, the cap and the page, inline or spaced", () => {
    expect(
      parseFlags(["--apply", "--org", ORG, "--limit=25", "--page", "5"]),
    ).toEqual({ apply: true, orgId: ORG, pageSize: 5, maxRuns: 25 });
  });

  it.each([
    [["--org", "acme"], "--org takes an organization uuid"],
    [["--limit", "0"], "--limit takes a positive integer"],
    [["--page=x"], "--page takes a positive integer"],
    [["--org"], "--org needs a value"],
    [["--wat"], "unknown flag --wat"],
  ])("refuses %j (negative)", (argv, message) => {
    expect(() => parseFlags(argv)).toThrow(message);
  });
});
