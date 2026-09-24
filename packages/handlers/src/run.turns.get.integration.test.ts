// `get_run_turns` against a real ClickHouse: the rows the grouped SQL answers
// must equal the rows the same run's frames add up to when read the way the
// transcript reads them (every chain spliced in where it was spawned, the
// proxy's late-report rule applied) and counted frame by frame
// (`framesTurns`). A mocked client accepts any SQL, so only a live server can
// tell a query that counts right from one that does not.
//
// The fixture is one wrapped run built to exercise every rule the contract
// states: a model call three sources reported and a transcript message's
// further block, a harness report after the proxy began observing, parallel
// and duplicated tool results, unkeyed tool frames, a turn with no cost, cost
// recorded before the first turn, and subagent chains placed by tool call id,
// by agent id, by when they began, and inside another subagent. One subagent
// chain is observed by the proxy partway through, so the late-report rule is
// held per chain. A second run records no `turn_start`, opens its turns on the
// turn index, and has a subagent that began before its first frame.
//
// Skipped unless a ClickHouse at CLICKHOUSE_URL already holds `tacho_events`.
// CI's test job runs one with the migrations applied. Each run writes under
// fresh organization and workspace ids, so it reads only its own rows.
import { randomUUID } from "node:crypto";
import {
  RUN_TURNS_MAX,
  runTurnsGet,
} from "@oxagen/oxagen/contracts/run.turns.get";
import { runInTenantScope } from "@oxagen/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

/**
 * Whether a ClickHouse answers and already holds `tacho_events`. CI's test job
 * migrates the store before the tests run; the migrator itself takes a
 * Postgres lock, so this suite does not run it.
 */
async function tachoEventsReady(): Promise<boolean> {
  try {
    const url = new URL("/", process.env.CLICKHOUSE_URL);
    url.searchParams.set("database", process.env.CLICKHOUSE_DATABASE ?? "");
    url.searchParams.set("query", "EXISTS TABLE tacho_events");
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
      headers: {
        "X-ClickHouse-User": process.env.CLICKHOUSE_USERNAME ?? "default",
        "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD ?? "",
      },
    });
    return res.ok && (await res.text()).trim() === "1";
  } catch {
    return false;
  }
}

const chUp = await tachoEventsReady();

const SCOPE = { orgId: randomUUID(), workspaceId: randomUUID() };
const ROOT = randomUUID();
const CHILD_A = randomUUID();
const CHILD_B = randomUUID();
const CHILD_LOOSE = randomUUID();
const NESTED = randomUUID();
const INDEXED = randomUUID();
const INDEXED_EARLY = randomUUID();
const RUN_ID = "tse_turnsintegration0000001";
const INDEXED_ID = "tse_turnsintegration0000002";

const BASE = Date.parse("2026-09-11T09:00:00.000Z");
/** ClickHouse DateTime64 text, `at` seconds after the run began. */
const tsAt = (at: number) =>
  new Date(BASE + at * 1000).toISOString().replace("T", " ").replace("Z", "");

type Row = Record<string, unknown>;

/** One `tacho_events` row with its body JSON and promoted columns in step. */
function row(
  session: string,
  seq: number,
  at: number,
  kind: string,
  over: {
    root?: string;
    parent?: string | null;
    subagentId?: string;
    spawnToolUseId?: string;
    source?: string;
    fidelity?: string;
    attrs?: Record<string, string>;
    toolUseId?: string;
    cost?: number | null;
    turnSeq?: number | null;
    input?: number;
    cacheRead?: number;
    requestId?: string;
    bytesRef?: string;
  } = {},
): Row {
  const body: Record<string, unknown> = {};
  if (over.input !== undefined) body["input_tokens"] = over.input;
  if (over.cacheRead !== undefined) body["cache_read_tokens"] = over.cacheRead;
  if (over.requestId !== undefined) body["request_id"] = over.requestId;
  const root = over.root ?? ROOT;
  return {
    org_id: SCOPE.orgId,
    workspace_id: SCOPE.workspaceId,
    session_uuid: session,
    root_session_uuid: root,
    parent_session_uuid:
      over.parent !== undefined ? over.parent : session === root ? null : root,
    subagent_id: over.subagentId ?? "",
    subagent_type: over.subagentId === undefined ? "" : "general-purpose",
    spawn_tool_use_id: over.spawnToolUseId ?? "",
    spawn_depth: session === root ? 0 : 1,
    seq,
    ts: tsAt(at),
    event_id: randomUUID(),
    event_id_idem: `${session}:${seq}`,
    kind,
    prev_hash: `sha256:${String(Math.max(0, seq - 1)).padStart(64, "0")}`,
    hash: `sha256:${String(seq).padStart(64, "0")}`,
    content_digest:
      over.bytesRef === undefined ? "" : `sha256:${"c".repeat(64)}`,
    bytes_ref: over.bytesRef ?? "",
    body: JSON.stringify(body),
    source: over.source ?? "hook",
    fidelity: over.fidelity ?? "hook",
    attrs: over.attrs ?? {},
    tool_name: kind === "tool_requested" || kind === "tool_call" ? "Bash" : "",
    tool_status: kind === "tool_call" ? "ok" : "",
    tool_use_id: over.toolUseId ?? "",
    model: kind === "llm_call" ? "claude-sonnet-5" : "",
    provider: kind === "llm_call" ? "anthropic" : "",
    cost_usd_micros: over.cost ?? null,
    turn_seq: over.turnSeq ?? null,
    input_tokens: over.input ?? null,
    cache_read_tokens: over.cacheRead ?? null,
    request_id: over.requestId ?? "",
    received_at: tsAt(at),
  };
}

const DUP = "oxagen.llm_call_duplicate_of";
const observed = {
  source: "collector",
  fidelity: "proxy",
  attrs: { "oxagen.metering": "observed" },
};

/** The wrapped run, root chain first, then its subagents. */
const ROWS: Row[] = [
  // Before the first turn: the agent starting, with a cost record of its own.
  row(ROOT, 0, 0, "agent_start", { cost: 5 }),
  // Turn 1.
  row(ROOT, 1, 1, "turn_start"),
  row(ROOT, 2, 2, "llm_call", {
    ...observed,
    cost: 100,
    input: 10,
    cacheRead: 90,
    requestId: "req_1",
    bytesRef: "evb:v1:k:proxy",
  }),
  // The same call as the transcript and the OTel log saw it, and the
  // transcript message's second content block.
  row(ROOT, 3, 3, "llm_call", {
    source: "transcript",
    attrs: { [DUP]: "collector" },
    cost: 100,
    input: 10,
    cacheRead: 90,
    requestId: "req_1",
    bytesRef: "evb:v1:k:transcript",
  }),
  row(ROOT, 4, 3, "llm_call", {
    source: "transcript",
    attrs: { [DUP]: "transcript" },
    requestId: "req_1",
  }),
  row(ROOT, 5, 3, "llm_call", {
    source: "otel_log",
    attrs: { [DUP]: "collector" },
    cost: 100,
    input: 10,
    requestId: "req_1",
  }),
  // Two tool calls in parallel, one gated, one result copied by the OTel log.
  row(ROOT, 6, 4, "tool_requested", { toolUseId: "tu_a" }),
  row(ROOT, 7, 4, "policy_decision", { toolUseId: "tu_b" }),
  row(ROOT, 8, 4, "tool_requested", { toolUseId: "tu_b" }),
  row(ROOT, 9, 5, "tool_call", { toolUseId: "tu_a" }),
  row(ROOT, 10, 5, "tool_call", { toolUseId: "tu_b" }),
  row(ROOT, 11, 5, "tool_call", { toolUseId: "tu_a", source: "otel_log" }),
  // A Task call that spawns subagent A.
  row(ROOT, 12, 6, "tool_requested", { toolUseId: "tu_task" }),
  row(ROOT, 13, 6, "subagent_start", {
    toolUseId: "tu_task",
    attrs: { "hook.agent_id": "agent_a" },
  }),
  row(ROOT, 14, 20, "tool_call", { toolUseId: "tu_task" }),
  // The harness reporting a call the proxy was already observing.
  row(ROOT, 15, 21, "llm_call", { cost: 60, input: 6, requestId: "req_2" }),
  row(ROOT, 16, 22, "turn_end"),
  // Turn 2: tool frames with no call id, and a model call nothing priced.
  row(ROOT, 17, 30, "turn_start"),
  row(ROOT, 18, 31, "tool_requested"),
  row(ROOT, 19, 32, "tool_call"),
  row(ROOT, 20, 33, "tool_call"),
  row(ROOT, 21, 34, "llm_call", { source: "otel_log", requestId: "req_3" }),
  // Turn 3: a subagent named only by its agent id.
  row(ROOT, 22, 50, "turn_start"),
  row(ROOT, 23, 51, "subagent_start", {
    attrs: { "hook.agent_id": "agent_b" },
  }),
  row(ROOT, 24, 60, "llm_call", {
    ...observed,
    cost: 30,
    input: 3,
    cacheRead: 27,
    requestId: "req_4",
  }),
  // Subagent A, spawned by tu_task in turn 1.
  row(CHILD_A, 0, 7, "turn_start", {
    subagentId: "agent_a",
    spawnToolUseId: "tu_task",
  }),
  row(CHILD_A, 1, 8, "llm_call", {
    subagentId: "agent_a",
    spawnToolUseId: "tu_task",
    cost: 20,
    input: 5,
    cacheRead: 15,
    requestId: "req_a1",
  }),
  row(CHILD_A, 2, 9, "tool_requested", {
    subagentId: "agent_a",
    spawnToolUseId: "tu_task",
    toolUseId: "tu_a1",
  }),
  row(CHILD_A, 3, 9, "subagent_start", {
    subagentId: "agent_a",
    spawnToolUseId: "tu_task",
    toolUseId: "tu_a1",
    attrs: { "hook.agent_id": "agent_nested" },
  }),
  row(CHILD_A, 4, 12, "tool_call", {
    subagentId: "agent_a",
    spawnToolUseId: "tu_task",
    toolUseId: "tu_a1",
  }),
  // The proxy begins observing subagent A's calls, so the harness's report of
  // the next one is a second account of a call already metered.
  row(CHILD_A, 5, 13, "llm_call", {
    ...observed,
    subagentId: "agent_a",
    spawnToolUseId: "tu_task",
    cost: 9,
    input: 2,
    requestId: "req_a2",
  }),
  row(CHILD_A, 6, 14, "llm_call", {
    subagentId: "agent_a",
    spawnToolUseId: "tu_task",
    cost: 9,
    input: 4,
    requestId: "req_a3",
  }),
  // A subagent spawned by subagent A.
  row(NESTED, 0, 10, "llm_call", {
    parent: CHILD_A,
    subagentId: "agent_nested",
    spawnToolUseId: "tu_a1",
    cost: 1,
    input: 1,
    requestId: "req_n1",
  }),
  // Subagent B, named by agent id in turn 3.
  row(CHILD_B, 0, 52, "llm_call", {
    subagentId: "agent_b",
    cost: 7,
    requestId: "req_b1",
  }),
  // A subagent no spawn names, which began during turn 2.
  row(CHILD_LOOSE, 0, 35, "llm_call", {
    subagentId: "agent_loose",
    cost: 3,
    requestId: "req_l1",
  }),
  row(CHILD_LOOSE, 1, 36, "tool_call", {
    subagentId: "agent_loose",
    toolUseId: "tu_l1",
  }),
];

/** A run with no turn_start: its turns follow the recorded turn index. */
const INDEXED_ROWS: Row[] = [
  // A subagent no spawn names, which began before the run's first frame.
  row(INDEXED_EARLY, 0, -5, "llm_call", {
    root: INDEXED,
    subagentId: "agent_early",
    cost: 4,
    requestId: "ie1",
  }),
  row(INDEXED, 0, 0, "agent_start", { root: INDEXED }),
  row(INDEXED, 1, 1, "llm_call", {
    root: INDEXED,
    turnSeq: 1,
    cost: 10,
    requestId: "i1",
  }),
  row(INDEXED, 2, 2, "tool_call", {
    root: INDEXED,
    turnSeq: 1,
    toolUseId: "x",
  }),
  row(INDEXED, 3, 3, "llm_call", {
    root: INDEXED,
    turnSeq: 2,
    cost: 20,
    requestId: "i2",
  }),
  row(INDEXED, 4, 4, "oxagen:hook_health", { root: INDEXED }),
  row(INDEXED, 5, 5, "llm_call", {
    root: INDEXED,
    turnSeq: 3,
    cost: 30,
    requestId: "i3",
  }),
];

const CHILDREN: Record<string, string[]> = {
  [ROOT]: [CHILD_A, CHILD_B, CHILD_LOOSE, NESTED],
  [INDEXED]: [INDEXED_EARLY],
};

async function harness() {
  const telemetry = await import("@oxagen/telemetry");
  const { memoryStores, tachoSession } = await import("./run.test-support");
  const { createRunTurnsGetHandler } = await import("./run.turns.get");
  const stores = memoryStores(
    [],
    [
      tachoSession({
        scope: SCOPE,
        publicId: RUN_ID,
        session: {
          sessionUuid: ROOT,
          seqCount: ROWS.filter((r) => r["session_uuid"] === ROOT).length,
        },
      }),
      tachoSession({
        scope: SCOPE,
        publicId: INDEXED_ID,
        session: {
          id: "0192d4a8-7c1e-7000-8000-00000000c0df",
          sessionUuid: INDEXED,
          seqCount: INDEXED_ROWS.filter((r) => r["session_uuid"] === INDEXED)
            .length,
        },
      }),
    ],
  );
  const deps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: () => Promise.resolve([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: telemetry.selectTachoEvents,
    tachoSubagentFrames: telemetry.selectTachoSubagentEvents,
    tachoChildSessions: (root: string) => Promise.resolve(CHILDREN[root] ?? []),
    tachoTurnFacts: telemetry.selectTachoTurnFacts,
    tachoTurnGroups: telemetry.selectTachoTurnGroups,
  };
  return { deps, turns: createRunTurnsGetHandler(deps) };
}

/** The same run read as the transcript reads it and counted frame by frame. */
async function reference(runId: string) {
  const { deps } = await harness();
  const { ctx } = await import("./run.test-support");
  const { readRunFrames, resolveRun, withoutLateReports } = await import(
    "./lib/run-read"
  );
  const { framesTurns } = await import("./lib/run-turns");
  const run = await resolveRun(deps, ctx(SCOPE), runId);
  const read = await readRunFrames(deps, run, 10_000);
  expect(read.complete).toBe(true);
  return framesTurns(withoutLateReports(read.frames), RUN_TURNS_MAX);
}

describe.skipIf(!chUp)("get_run_turns against ClickHouse", () => {
  beforeAll(async () => {
    const { clickhouse } = await import("@oxagen/telemetry");
    await clickhouse().insert({
      table: "tacho_events",
      format: "JSONEachRow",
      values: [...ROWS, ...INDEXED_ROWS],
    });
  }, 120_000);

  afterAll(async () => {
    const { closeClickhouse } = await import("@oxagen/telemetry");
    await closeClickhouse();
  });

  it("answers what the run's frames add up to, read as the transcript reads them", async () => {
    const { turns } = await harness();
    const { ctx } = await import("./run.test-support");
    const out = await runInTenantScope(SCOPE, () =>
      turns(runTurnsGet.input.parse({ runId: RUN_ID }), ctx(SCOPE)),
    );
    const expected = await runInTenantScope(SCOPE, () => reference(RUN_ID));
    expect(runTurnsGet.output.parse(out)).toEqual(out);
    expect(out.turns).toEqual(expected.turns);
    expect(out.complete).toBe(true);

    // The fixture exercises what it claims to.
    expect(
      out.turns.map((t) => [
        t.turn,
        t.frames,
        t.modelSteps,
        t.toolSteps,
        t.cost?.micros ?? null,
      ]),
    ).toEqual([
      // Root 16 frames, subagent A 7, the nested chain 1. One model call on
      // the root however many sighted it, and the late report, then A's three
      // and the nested chain's. Tool calls: tu_a, tu_b, tu_task, and A's
      // tu_a1. Cost: the proxy's 100, A's 20 and 9, and the nested 1. The two
      // late reports (the root's 60, A's second 9) and the sightings' copies
      // count for nothing.
      [1, 24, 6, 4, "130"],
      // Root 5 frames and the loose subagent's 2. The unkeyed request and its
      // two results pair as two calls; the loose chain's tool call is a third.
      [2, 7, 2, 3, "3"],
      [3, 4, 2, 0, "37"],
    ]);
    expect(out.turns[0]?.cumulativeCost?.micros).toBe("135");
    expect(out.turns[0]?.tokens).toEqual({ inputUncached: 18, cacheRead: 105 });
    expect(out.turns[1]?.tokens).toEqual({
      inputUncached: null,
      cacheRead: null,
    });
    expect(out.turns[2]?.cumulativeCost?.micros).toBe("175");
  });

  it("opens the turns on the turn index for a recording with no turn_start", async () => {
    const { turns } = await harness();
    const { ctx } = await import("./run.test-support");
    const out = await runInTenantScope(SCOPE, () =>
      turns(runTurnsGet.input.parse({ runId: INDEXED_ID }), ctx(SCOPE)),
    );
    const expected = await runInTenantScope(SCOPE, () => reference(INDEXED_ID));
    expect(out.turns).toEqual(expected.turns);
    // The subagent that began before the run's first frame is in turn 1, and
    // the turn still opens on the run's own first frame.
    expect(out.turns.map((t) => [t.turn, t.seq, t.at, t.frames])).toEqual([
      [1, "0", "2026-09-11T09:00:00.000Z", 4],
      [2, "3", "2026-09-11T09:00:03.000Z", 2],
      [3, "5", "2026-09-11T09:00:05.000Z", 1],
    ]);
    expect(out.turns[0]?.cost?.micros).toBe("14");
  });
});
