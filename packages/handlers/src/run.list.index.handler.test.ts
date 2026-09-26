// list_runs over the run index (#3837), end to end through the handler: which
// inputs the index answers, the order it keeps, when a page carries a cursor,
// the bounded total beside every page but a pull-request filter's, and the
// input combinations the handler refuses before it reads anything.
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  RUN_LIST_TOTAL_BOUND,
  runList,
  type RunListInput,
} from "@oxagen/oxagen/contracts/run.list";
import { describe, expect, it, vi } from "vitest";
import { createRunListHandler, decodeRunCursor } from "./run.list";
import type {
  RunIndexDeps,
  RunIndexEntry,
  RunIndexRequest,
} from "./run.list.index";
import { ctx, ledgerRun, memoryStores, tachoSession } from "./run.test-support";

const ledgerA = ledgerRun({
  publicId: "arun_a",
  runId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
});
const tachoB = tachoSession({
  publicId: "tse_b",
  session: { startedAt: new Date("2026-09-11T11:00:00.000Z") },
});
const tachoC = tachoSession({
  publicId: "tse_c",
  session: {
    sessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000c3",
    startedAt: new Date("2026-09-11T08:00:00.000Z"),
    pullRequests: 1,
  },
});

/**
 * An index that answers `entries` for every page and `count` for every count,
 * and records what it was asked.
 */
function fakeIndex(entries: RunIndexEntry[], count = entries.length) {
  const pages: RunIndexRequest[] = [];
  const counts: RunIndexRequest[] = [];
  const deps: RunIndexDeps = {
    index: {
      page: vi.fn((_scope, req: RunIndexRequest) => {
        pages.push(req);
        return Promise.resolve(entries.slice(0, req.limit + 1));
      }),
      count: vi.fn((_scope, req: RunIndexRequest) => {
        counts.push(req);
        return Promise.resolve(count);
      }),
    },
    rows: {
      ledger: (_scope, ids) =>
        Promise.resolve(
          [ledgerA]
            .filter((row) => ids.includes(row.run.publicId))
            .map((row) => ({ run: row.run, identity: row.identity })),
        ),
      tacho: (_scope, ids) =>
        Promise.resolve(
          [tachoB, tachoC].filter((row) => ids.includes(row.session.publicId)),
        ),
    },
  };
  return { deps, pages, counts };
}

function list(runIndex: RunIndexDeps | undefined) {
  const stores = memoryStores([ledgerA], [tachoB, tachoC]);
  return createRunListHandler({ ...stores, runIndex });
}

// Fleet asks for the total; every case here does too unless it says not.
const parse = (over: Partial<RunListInput>) =>
  runList.input.parse({ count: true, ...over });

const ALL: RunIndexEntry[] = [
  { source: "tacho", publicId: "tse_c" },
  { source: "ledger", publicId: "arun_a" },
  { source: "tacho", publicId: "tse_b" },
];

describe("list_runs with the run index", () => {
  it("lists a plain page on the keyset path and adds the total", async () => {
    const { deps, pages, counts } = fakeIndex(ALL, 279);
    const out = await list(deps)(parse({ limit: 10 }), ctx());
    expect(out.runs.map((run) => run.id)).toEqual(["tse_b", "arun_a", "tse_c"]);
    expect(pages).toHaveLength(0);
    expect(counts).toHaveLength(1);
    expect(out.total).toBe(279);
    expect(out.totalBound).toBe(RUN_LIST_TOTAL_BOUND);
  });

  it("reads no count and answers no total when the caller does not ask", async () => {
    const { deps, counts } = fakeIndex(ALL, 279);
    const out = await list(deps)(runList.input.parse({ limit: 10 }), ctx());
    expect(out.runs).toHaveLength(3);
    expect(counts).toHaveLength(0);
    expect(out).not.toHaveProperty("total");
    expect(out).not.toHaveProperty("totalBound");
  });

  it("reads null past the bound", async () => {
    const { deps } = fakeIndex(ALL, RUN_LIST_TOTAL_BOUND + 1);
    const out = await list(deps)(parse({}), ctx());
    expect(out.total).toBeNull();
    expect(out.totalBound).toBe(RUN_LIST_TOTAL_BOUND);
  });

  it("keeps the index's order for a filtered page and counts the same filter", async () => {
    const { deps, pages, counts } = fakeIndex(ALL, 3);
    const out = await list(deps)(
      parse({ status: ["sealed"], query: "deploy", limit: 10 }),
      ctx(),
    );
    expect(out.runs.map((run) => run.id)).toEqual(["tse_c", "arun_a", "tse_b"]);
    expect(out.total).toBe(3);
    expect(pages[0]).toMatchObject({
      status: ["sealed"],
      query: "deploy",
      offset: 0,
      limit: 10,
      sessionsOnly: false,
    });
    expect(counts[0]).toMatchObject({ status: ["sealed"], query: "deploy" });
  });

  it("gives a newest-first filtered page a cursor after its last row", async () => {
    const { deps } = fakeIndex(ALL);
    const out = await list(deps)(parse({ tier: ["observe"], limit: 2 }), ctx());
    expect(out.runs.map((run) => run.id)).toEqual(["tse_c", "arun_a"]);
    expect(out.nextCursor).not.toBeNull();
    expect(decodeRunCursor(out.nextCursor ?? "")).toEqual({
      at: "2026-09-11T10:00:01.000Z",
      id: "arun_a",
    });
  });

  it("pages any other order by offset and hands back no cursor", async () => {
    const { deps, pages } = fakeIndex(ALL);
    const out = await list(deps)(
      parse({ sort: { key: "cost", dir: "desc" }, offset: 25, limit: 2 }),
      ctx(),
    );
    expect(out.nextCursor).toBeNull();
    expect(pages[0]).toMatchObject({
      order: { key: "cost", dir: "desc" },
      offset: 25,
    });
  });

  it("filters wrapped sessions by pull request over the index, with no total", async () => {
    const { deps, pages, counts } = fakeIndex([
      { source: "tacho", publicId: "tse_b" },
      { source: "tacho", publicId: "tse_c" },
    ]);
    const out = await list(deps)(
      parse({ pullRequests: "with", status: ["sealed"] }),
      ctx(),
    );
    // tse_c counted a pr_open call; tse_b named none.
    expect(out.runs.map((run) => run.id)).toEqual(["tse_c"]);
    expect(pages[0]?.sessionsOnly).toBe(true);
    expect(counts).toHaveLength(0);
    expect(out.total).toBeUndefined();
  });

  it("carries no total when the count fails", async () => {
    const { deps } = fakeIndex(ALL);
    vi.mocked(deps.index.count).mockRejectedValue(new Error("timeout"));
    const out = await list(deps)(parse({}), ctx());
    expect(out.runs).toHaveLength(3);
    expect(out.total).toBeUndefined();
    expect(out.totalBound).toBeUndefined();
  });

  it.each<[string, Partial<RunListInput>]>([
    ["cursor_with_offset", { offset: 0 }],
    ["cursor_with_sort", { sort: { key: "agent", dir: "asc" } }],
  ])("refuses %s before it reads", async (code, over) => {
    const { deps, pages, counts } = fakeIndex(ALL);
    const first = await list(deps)(parse({ limit: 1 }), ctx());
    const cursor = first.nextCursor ?? "";
    await expect(
      list(deps)(parse({ cursor, ...over }), ctx()),
    ).rejects.toMatchObject({ code: "invalid_input", message: code });
    expect(pages).toHaveLength(0);
    expect(counts).toHaveLength(1);
  });

  it("refuses a pull-request filter with an offset", async () => {
    const { deps } = fakeIndex(ALL);
    const refused = list(deps)(
      parse({ pullRequests: "without", offset: 10 }),
      ctx(),
    );
    await expect(refused).rejects.toBeInstanceOf(CapabilityError);
    await expect(refused).rejects.toMatchObject({
      message: "pull_requests_with_offset",
    });
  });

  it("fails loudly when an input needs the index and none is wired", async () => {
    await expect(
      list(undefined)(parse({ query: "deploy" }), ctx()),
    ).rejects.toThrow("the run index is not wired");
  });

  it("lists as before with no index wired and no index input", async () => {
    const out = await list(undefined)(parse({}), ctx());
    expect(out.runs).toHaveLength(3);
    expect(out.total).toBeUndefined();
  });
});
