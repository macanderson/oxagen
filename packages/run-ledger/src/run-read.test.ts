/**
 * The frames a run's transcript folds, composed once (ADR-182). The Run
 * page's `get_run_transcript` and the `run.summarize` job both read through
 * `readTranscriptFrames`, so these are the only tests of the composition.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const dbMock = {
    ...(await importOriginal<typeof import("@oxagen/database")>()),
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/pg-proxy";
import {
  type RunFrame,
  tachoFrame,
  type TachoFrameRowLike,
} from "./run-frames";
import {
  type FrameRead,
  listSubagentChains,
  listSubagentSessions,
  readRunChains,
  readTranscriptFrames,
  type RunChainReads,
  subagentChainRead,
  subagentChainsQuery,
  subagentSessionsQuery,
  withoutLateReports,
} from "./run-read";

const ROOT = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
};
const DUP = "oxagen.llm_call_duplicate_of";

function row(
  seq: number,
  over: Partial<TachoFrameRowLike> = {},
): TachoFrameRowLike {
  return {
    seq,
    ts: `2026-09-11 09:00:${String(seq).padStart(2, "0")}.000`,
    kind: "llm_call",
    hash: `sha256:${String(seq).padStart(64, "0")}`,
    contentDigest: "",
    bytesRef: "",
    redactions: "",
    toolName: "",
    toolStatus: "",
    toolUseId: "",
    model: "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: null,
    ...over,
  };
}

/** A frame recorded on the subagent chain under the root. */
const onChild = (seq: number, over: Partial<TachoFrameRowLike> = {}) =>
  row(seq, {
    sessionUuid: CHILD,
    rootSessionUuid: ROOT,
    parentSessionUuid: ROOT,
    ...over,
  });

/** A read that answers `frames` as they are, uncut. */
const whole = (frames: RunFrame[]) => (cap: number) =>
  Promise.resolve<FrameRead>({
    frames: frames.slice(0, cap),
    complete: frames.length <= cap,
  });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("readRunChains", () => {
  const root = [row(0), row(1), row(2)].map(tachoFrame);
  const child = [onChild(0), onChild(1)].map(tachoFrame);

  it("splices every subagent chain into the run's own chain", async () => {
    const read = await readRunChains(
      { own: whole(root), subagents: whole(child) },
      10,
    );
    expect(read.complete).toBe(true);
    // No spawn was recorded, so the chain goes before the first root frame
    // observed after it began.
    expect(read.frames.map((f) => f.chain?.sessionUuid ?? "root")).toEqual([
      "root",
      CHILD,
      CHILD,
      "root",
      "root",
    ]);
  });

  it("caps the chains together, the run's own chain first, and says the cap cut it (negative)", async () => {
    const read = await readRunChains(
      { own: whole(root), subagents: whole(child) },
      4,
    );
    expect(read.frames).toHaveLength(4);
    expect(read.frames.filter((f) => f.chain === undefined)).toHaveLength(3);
    expect(read.complete).toBe(false);
  });

  it("reads only the run's own chain when the run has no subagent read (negative)", async () => {
    const own = vi.fn(whole(root));
    const read = await readRunChains({ own, subagents: null }, 10);
    expect(read.frames).toHaveLength(3);
    expect(own).toHaveBeenCalledWith(10);
  });
});

describe("withoutLateReports", () => {
  type Late = {
    seq: string;
    type: string;
    usageObserved?: boolean;
    chain?: { sessionUuid: string };
    usage: { input: number } | null;
    costMicros: string | null;
  };
  const call = (seq: number, over: Partial<Late> = {}): Late => ({
    seq: String(seq),
    type: "llm_call",
    usage: { input: 10 },
    costMicros: "5",
    ...over,
  });
  const strip = (frames: Late[]) =>
    withoutLateReports(
      frames as unknown as Parameters<typeof withoutLateReports>[0],
    ) as unknown as Late[];

  it("strips a harness report that follows the chain's first observed call, and none before it", () => {
    const frames = strip([
      call(1),
      call(2, { usageObserved: true }),
      call(3),
      call(4, { type: "tool_call" }),
    ]);
    expect(frames.map((f) => [f.seq, f.costMicros, f.usage])).toEqual([
      ["1", "5", { input: 10 }],
      ["2", "5", { input: 10 }],
      ["3", null, null],
      // Only a model call is a second account of a metered call.
      ["4", "5", { input: 10 }],
    ]);
  });

  it("holds the rule per chain, so an observed subagent leaves the root's reports standing", () => {
    const frames = strip([
      call(1, { chain: { sessionUuid: CHILD }, usageObserved: true }),
      call(2),
      call(3, { chain: { sessionUuid: CHILD } }),
    ]);
    expect(frames.map((f) => f.costMicros)).toEqual(["5", "5", null]);
  });
});

describe("readTranscriptFrames", () => {
  const body = (request: string) => JSON.stringify({ request_id: request });
  const retained = (seq: number) => ({
    contentDigest: `sha256:${String(seq).padStart(64, "e")}`,
    bytesRef: `evb:v1:k:${String(seq).padStart(64, "e")}`,
  });

  /**
   * A wrapped run whose proxy observed the root chain's first call. The
   * transcript's copy of that call carries nothing new; a later harness
   * report on the root is a second account of a metered call; the subagent
   * chain was never observed.
   */
  function wrappedRun(): RunChainReads {
    const observed = tachoFrame(
      row(0, {
        body: body("req_1"),
        source: "collector",
        costUsdMicros: 700,
        ...retained(0),
      }),
    );
    observed.usageObserved = true;
    const root = [
      observed,
      tachoFrame(
        row(1, {
          body: body("req_1"),
          source: "transcript",
          attrs: { [DUP]: "collector" },
        }),
      ),
      tachoFrame(
        row(2, { body: body("req_2"), source: "otel_log", costUsdMicros: 300 }),
      ),
    ];
    const child = [
      tachoFrame(
        onChild(0, {
          body: body("req_3"),
          source: "otel_log",
          costUsdMicros: 50,
        }),
      ),
    ];
    return { own: whole(root), subagents: whole(child) };
  }

  it("splices the subagents, uncounts the late report, and shows each model call once", async () => {
    const read = await readTranscriptFrames(wrappedRun(), 10);
    expect(read.complete).toBe(true);
    expect(
      read.frames.map((f) => [
        f.chain?.sessionUuid ?? "root",
        f.seq,
        f.costMicros,
      ]),
    ).toEqual([
      ["root", "0", 700],
      [CHILD, "0", 50],
      // The transcript's copy of seq 0 is gone; seq 2 is a harness report
      // after the proxy began observing the root chain.
      ["root", "2", null],
    ]);
  });

  it("says the cap cut the read short (negative)", async () => {
    const read = await readTranscriptFrames(wrappedRun(), 2);
    expect(read.complete).toBe(false);
  });
});

describe("subagentChainRead", () => {
  const rows = [onChild(0), onChild(1), onChild(2)];
  const reader = () =>
    vi.fn((args: { limit: number }) =>
      Promise.resolve(rows.slice(0, args.limit)),
    );

  it("reads every chain under the root in one read of one row past the cap", async () => {
    const read = reader();
    const got = await subagentChainRead(read, ROOT)(10);
    expect(got.complete).toBe(true);
    expect(got.frames.map((f) => f.chain?.sessionUuid)).toEqual([
      CHILD,
      CHILD,
      CHILD,
    ]);
    expect(read.mock.calls).toEqual([
      [{ rootSessionUuid: ROOT, after: null, limit: 11 }],
    ]);
  });

  it("says the cap cut the subagents short (negative)", async () => {
    const got = await subagentChainRead(reader(), ROOT)(2);
    expect(got.frames).toHaveLength(2);
    expect(got.complete).toBe(false);
  });

  it("names the chains Postgres lists, so ClickHouse reads only their ranges", async () => {
    const read = reader();
    const listed = vi.fn(() => Promise.resolve([CHILD]));
    await subagentChainRead(read, ROOT, listed)(10);
    expect(listed).toHaveBeenCalledWith(ROOT);
    expect(read.mock.calls).toEqual([
      [
        {
          rootSessionUuid: ROOT,
          after: null,
          limit: 11,
          sessionUuids: [CHILD],
        },
      ],
    ]);
  });

  it("reads nothing when Postgres lists no chains (negative)", async () => {
    const read = reader();
    const got = await subagentChainRead(read, ROOT, () => Promise.resolve([]))(
      10,
    );
    expect(got).toEqual({ frames: [], complete: true });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("listSubagentSessions", () => {
  // A query builder with no connection: the tests compile its SQL only.
  const db = drizzle(() => Promise.resolve({ rows: [] }), { schema });

  it("lists the chains under the root in the workspace, not the root itself", async () => {
    const compiled: Array<{ sql: string; params: unknown[] }> = [];
    mocks.withTenantDb.mockImplementation(
      (
        fn: (tx: unknown) => { toSQL(): { sql: string; params: unknown[] } },
      ) => {
        compiled.push(fn(db).toSQL());
        return Promise.resolve([{ sessionUuid: CHILD }]);
      },
    );
    expect(await listSubagentSessions(SCOPE, ROOT)).toEqual([CHILD]);
    const [query] = compiled;
    expect(query?.sql).toMatch(/"sessions"\."org_id" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."workspace_id" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."root_session_uuid" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."session_uuid" <> \$\d+/);
    expect(query?.params).toEqual([SCOPE.orgId, SCOPE.workspaceId, ROOT, ROOT]);
  });

  it("builds the same fenced query from any select seam", () => {
    const { sql } = subagentSessionsQuery(db, SCOPE, ROOT).toSQL();
    expect(sql).toContain('from "tacho"."sessions"');
  });
});

// #3823: every reader that answers a run's chains one by one lists them here.
describe("listSubagentChains", () => {
  const db = drizzle(() => Promise.resolve({ rows: [] }), { schema });

  function compiling(rows: unknown[]) {
    const compiled: Array<{ sql: string; params: unknown[] }> = [];
    mocks.withTenantDb.mockImplementation(
      (
        fn: (tx: unknown) => { toSQL(): { sql: string; params: unknown[] } },
      ) => {
        compiled.push(fn(db).toSQL());
        return Promise.resolve(rows);
      },
    );
    return compiled;
  }

  it("lists the chains under the root in the workspace, in the order they started, with their rows", async () => {
    const row = {
      sessionUuid: CHILD,
      sessionId: "0192d4a8-7c1e-7000-8000-00000000c1d0",
      parentSessionUuid: ROOT,
      subagentId: "agent-1",
      subagentType: "Explore",
      spawnToolUseId: "toolu_A",
      seqCount: 3,
    };
    const compiled = compiling([row]);
    expect(await listSubagentChains(SCOPE, ROOT)).toEqual([row]);
    const [query] = compiled;
    expect(query?.sql).toMatch(/"sessions"\."org_id" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."workspace_id" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."root_session_uuid" = \$\d+/);
    expect(query?.sql).toMatch(/"sessions"\."session_uuid" <> \$\d+/);
    expect(query?.sql).toMatch(
      /order by "sessions"\."started_at" asc, "sessions"\."id" asc/,
    );
    // Unnarrowed and uncapped: every chain the root holds.
    expect(query?.sql).not.toMatch(/ in \(/);
    expect(query?.sql).not.toMatch(/ limit /);
    expect(query?.params).toEqual([SCOPE.orgId, SCOPE.workspaceId, ROOT, ROOT]);
  });

  it("narrows to the chains asked for and caps the list", async () => {
    const compiled = compiling([]);
    await listSubagentChains(SCOPE, ROOT, {
      sessionUuids: [CHILD],
      limit: 201,
    });
    const [query] = compiled;
    expect(query?.sql).toMatch(/"sessions"\."session_uuid" in \(\$\d+\)/);
    expect(query?.sql).toMatch(/ limit \$\d+/);
    expect(query?.params).toEqual(
      expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId, ROOT, CHILD, 201]),
    );
  });

  it("reads nothing for an empty list of chains (negative)", async () => {
    expect(await listSubagentChains(SCOPE, ROOT, { sessionUuids: [] })).toEqual(
      [],
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("builds the same fenced query from any select seam", () => {
    const { sql } = subagentChainsQuery(db, SCOPE, ROOT).toSQL();
    expect(sql).toContain('from "tacho"."sessions"');
  });
});
