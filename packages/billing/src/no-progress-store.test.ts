// no-progress-store.test.ts — the no-progress check over one run, with the
// stores faked (spend spec, detector 1; #4490).
import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/database", () => ({
  schema: {},
  withSystemDb: vi.fn(() => {
    throw new Error("the check must not reach the database in this test");
  }),
}));
const readers = vi.hoisted(() => ({
  readRunToolCalls: vi.fn(),
  readTachoProgressFrames: vi.fn(),
}));
vi.mock("./cost-rollup-store", () => ({
  loadRunSource: vi.fn(),
  readRunToolCalls: readers.readRunToolCalls,
}));
vi.mock("@oxagen/telemetry", () => ({
  readTachoProgressFrames: readers.readTachoProgressFrames,
}));
const registry = vi.hoisted(() => ({ getCapability: vi.fn() }));
vi.mock("@oxagen/oxagen/registry", () => ({
  getCapability: registry.getCapability,
}));

import type { RunSource } from "./cost-rollup-store";
import type { ToolCallFrame } from "./cost-rollup";
import type { NoProgressFrame, NoProgressLimit } from "./no-progress";
import {
  checkNoProgress,
  limitOfPolicy,
  loopKeyOf,
  NO_PROGRESS_DEFAULT_LIMIT,
  pauseKeyOf,
  readNoProgressFrames,
  withDeclaredMutation,
  type NoProgressDeps,
  type NoProgressHit,
  type NoProgressPauseRequest,
  type NoProgressRun,
  type PauseRun,
} from "./no-progress-store";

const RUN: NoProgressRun = {
  runId: "tse_0000000000000000000001",
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  sealed: false,
};
const NOW = new Date("2026-09-26T12:00:00.000Z");
const SOURCE = {
  meta: { orgId: RUN.orgId, workspaceId: RUN.workspaceId },
  frames: { kind: "tacho" },
} as unknown as RunSource;

function call(over: Partial<ToolCallFrame> = {}): ToolCallFrame {
  return {
    name: "Bash",
    status: "ok",
    inputDigest: "sha256:poll",
    outputDigest: "sha256:pending",
    isMutating: null,
    resultTokens: null,
    ...over,
  };
}

function times(n: number): ToolCallFrame[] {
  return Array.from({ length: n }, () => call());
}

/** An in-memory `cost.no_progress_hits` with the upsert the store makes. */
function fakeHits() {
  const rows = new Map<string, NoProgressHit>();
  const writeHits = vi.fn(
    async (_run: NoProgressRun, hits: readonly NoProgressHit[]) => {
      for (const h of hits) {
        const key = loopKeyOf(h);
        const had = rows.get(key);
        rows.set(
          key,
          had ? { ...had, repeats: Math.max(had.repeats, h.repeats) } : h,
        );
      }
    },
  );
  const readRecorded = vi.fn(async () => new Set(rows.keys()));
  return { rows, writeHits, readRecorded };
}

function deps(
  limit: NoProgressLimit | null,
  calls: NoProgressFrame[],
  over: Partial<NoProgressDeps> = {},
) {
  const store = fakeHits();
  const d: NoProgressDeps = {
    now: () => NOW,
    readLimit: vi.fn(async () => limit),
    loadRunSource: vi.fn(async () => SOURCE),
    readFrames: vi.fn(async () => calls),
    readRecorded: store.readRecorded,
    writeHits: store.writeHits,
    pauseRun: null,
    ...over,
  };
  return { d, rows: store.rows };
}

/**
 * A pause path that keeps the contract the real one keeps: one pause per
 * loop key, and a request for a loop that already has one queues nothing.
 */
function idempotentPause() {
  const queued: string[] = [];
  const pauseRun = vi.fn<PauseRun>(async (request: NoProgressPauseRequest) => {
    const earlier = queued.findIndex((key) =>
      request.loops.some((l) => l.key === key),
    );
    if (earlier >= 0) return { paused: true, commandId: `tcm_${earlier + 1}` };
    const first = request.loops[0];
    if (first === undefined) throw new Error("a pause names at least one loop");
    queued.push(first.key);
    return { paused: true, commandId: `tcm_${queued.length}` };
  });
  return { queued, pauseRun };
}

describe("checkNoProgress", () => {
  it("records one hit for 20 identical calls at a limit of 20 in observe mode, and lets the run continue", async () => {
    const { pauseRun } = idempotentPause();
    const { d, rows } = deps({ repeats: 20, mode: "observe" }, times(20), {
      pauseRun,
    });
    const out = await checkNoProgress(RUN, d);
    expect(out).toEqual({ checked: true, loops: 1, newLoops: 1, paused: false });
    expect(pauseRun).not.toHaveBeenCalled();
    expect([...rows.values()]).toEqual([
      {
        tool: "Bash",
        inputDigest: "sha256:poll",
        outputDigest: "sha256:pending",
        loop: 1,
        repeats: 20,
        atCall: 20,
        limitRepeats: 20,
        mode: "observe",
        outcome: "would_pause",
        pauseBlock: null,
      },
    ]);
  });

  it("records observe hits at 20 for a workspace with no limit of its own, and lets the run continue", async () => {
    const { pauseRun } = idempotentPause();
    const { d, rows } = deps(limitOfPolicy(undefined), times(20), {
      pauseRun,
    });
    const out = await checkNoProgress(RUN, d);
    expect(out).toEqual({ checked: true, loops: 1, newLoops: 1, paused: false });
    expect(pauseRun).not.toHaveBeenCalled();
    expect([...rows.values()][0]).toMatchObject({
      limitRepeats: 20,
      mode: "observe",
      outcome: "would_pause",
      pauseBlock: null,
    });
  });

  it("records nothing short of the default's 20 calls", async () => {
    const { d } = deps(limitOfPolicy(undefined), times(19));
    expect(await checkNoProgress(RUN, d)).toMatchObject({
      checked: true,
      loops: 0,
    });
    expect(d.writeHits).not.toHaveBeenCalled();
  });

  it("keeps one hit per loop across passes, and raises its count", async () => {
    const calls = times(20);
    const { d, rows } = deps({ repeats: 20, mode: "observe" }, calls);
    await checkNoProgress(RUN, d);
    calls.push(...times(5));
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ loops: 1, newLoops: 0 });
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({ repeats: 25, atCall: 20 });
  });

  it("records no hit when a file changes between the calls (negative)", async () => {
    const calls = [...times(10), { fileChanged: true as const }, ...times(10)];
    const { d } = deps({ repeats: 20, mode: "observe" }, calls);
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ checked: true, loops: 0 });
    expect(d.writeHits).not.toHaveBeenCalled();
  });

  it("records a second hit for a second loop in the same run", async () => {
    const calls = [
      ...times(20),
      call({ name: "Edit", isMutating: true }),
      ...times(20),
    ];
    const { d, rows } = deps({ repeats: 20, mode: "observe" }, calls);
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ loops: 2, newLoops: 2 });
    expect([...rows.values()].map((r) => [r.loop, r.atCall])).toEqual([
      [1, 20],
      [2, 41],
    ]);
  });

  it("pauses the run once and records paused in enforced mode when the pause path is reachable", async () => {
    const { queued, pauseRun } = idempotentPause();
    const calls = times(20);
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, calls, {
      pauseRun,
    });
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ newLoops: 1, paused: true });
    expect(pauseRun).toHaveBeenCalledTimes(1);
    const loop = {
      tool: "Bash",
      inputDigest: "sha256:poll",
      outputDigest: "sha256:pending",
      loop: 1,
      repeats: 20,
      atCall: 20,
    };
    expect(pauseRun).toHaveBeenCalledWith({
      ...RUN,
      loops: [{ ...loop, key: pauseKeyOf(loop) }],
      limit: { repeats: 20, mode: "enforced" },
    });
    expect(queued).toHaveLength(1);
    expect([...rows.values()][0]).toMatchObject({
      mode: "enforced",
      outcome: "paused",
      pauseBlock: null,
    });

    // The loop goes on after the operator resumes the run: no second pause.
    calls.push(...times(10));
    await checkNoProgress(RUN, d);
    expect(pauseRun).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({
      repeats: 30,
      outcome: "paused",
    });
  });

  it("queues no second pause when the write fails after the pause and the check retries (#4503)", async () => {
    const { queued, pauseRun } = idempotentPause();
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, times(20), {
      pauseRun,
    });
    const write = d.writeHits;
    let failed = false;
    d.writeHits = vi.fn(async (...args: Parameters<typeof write>) => {
      if (!failed) {
        failed = true;
        throw new Error("connection reset");
      }
      return write(...args);
    });
    await expect(checkNoProgress(RUN, d)).rejects.toThrow("connection reset");
    expect(queued).toHaveLength(1);
    expect(rows.size).toBe(0);

    // The step retries. The loop is still unrecorded, so the check asks the
    // pause path again for the same loop, which queues nothing.
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ newLoops: 1, paused: true });
    expect(pauseRun).toHaveBeenCalledTimes(2);
    expect(pauseRun.mock.calls[1]?.[0].loops[0]?.key).toBe(
      pauseRun.mock.calls[0]?.[0].loops[0]?.key,
    );
    expect(queued).toHaveLength(1);
    expect([...rows.values()][0]).toMatchObject({
      outcome: "paused",
      pauseBlock: null,
    });
  });

  it("records would_pause with pause_unavailable in enforced mode when no pause path is installed", async () => {
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, times(20));
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ newLoops: 1, paused: false });
    expect([...rows.values()][0]).toMatchObject({
      mode: "enforced",
      outcome: "would_pause",
      pauseBlock: "pause_unavailable",
    });
  });

  it("records would_pause and the reason when the run has no governed call to pause at", async () => {
    const pauseRun = vi.fn<PauseRun>(async () => ({
      paused: false,
      block: "host_offline",
    }));
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, times(20), {
      pauseRun,
    });
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ paused: false });
    expect(pauseRun).toHaveBeenCalledTimes(1);
    expect([...rows.values()][0]).toMatchObject({
      mode: "enforced",
      outcome: "would_pause",
      pauseBlock: "host_offline",
    });
  });

  it("does not pause a sealed run, and records why", async () => {
    const { pauseRun } = idempotentPause();
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, times(20), {
      pauseRun,
    });
    await checkNoProgress({ ...RUN, sealed: true }, d);
    expect(pauseRun).not.toHaveBeenCalled();
    expect([...rows.values()][0]).toMatchObject({
      outcome: "would_pause",
      pauseBlock: "run_sealed",
    });
  });

  it("asks one pause for two loops found in one pass, the first leading", async () => {
    const { queued, pauseRun } = idempotentPause();
    const calls = [
      ...times(20),
      call({ name: "Edit", isMutating: true }),
      ...times(20),
    ];
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, calls, {
      pauseRun,
    });
    await checkNoProgress(RUN, d);
    expect(pauseRun).toHaveBeenCalledTimes(1);
    expect(pauseRun.mock.calls[0]?.[0].loops.map((l) => l.loop)).toEqual([
      1, 2,
    ]);
    expect(queued).toHaveLength(1);
    expect([...rows.values()].map((r) => r.outcome)).toEqual([
      "paused",
      "paused",
    ]);
  });

  it("records no hit and reads no calls for a workspace whose team cleared its limit", async () => {
    const { d } = deps(null, times(40));
    const out = await checkNoProgress(RUN, d);
    expect(out).toEqual({
      checked: false,
      loops: 0,
      newLoops: 0,
      paused: false,
    });
    expect(d.loadRunSource).not.toHaveBeenCalled();
    expect(d.readFrames).not.toHaveBeenCalled();
    expect(d.writeHits).not.toHaveBeenCalled();
  });

  it("writes nothing when no loop reaches the limit", async () => {
    const { d } = deps({ repeats: 20, mode: "observe" }, times(19));
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ checked: true, loops: 0 });
    expect(d.writeHits).not.toHaveBeenCalled();
  });

  it("skips a run whose record names another workspace (negative)", async () => {
    const other = {
      ...SOURCE,
      meta: {
        orgId: RUN.orgId,
        workspaceId: "00000000-0000-4000-8000-0000000000ff",
      },
    } as unknown as RunSource;
    const { d } = deps({ repeats: 20, mode: "observe" }, times(20), {
      loadRunSource: vi.fn(async () => other),
    });
    const out = await checkNoProgress(RUN, d);
    expect(out.checked).toBe(false);
    expect(d.readFrames).not.toHaveBeenCalled();
    expect(d.writeHits).not.toHaveBeenCalled();
  });

  it("skips a run no store has", async () => {
    const { d } = deps({ repeats: 20, mode: "observe" }, times(20), {
      loadRunSource: vi.fn(async () => null),
    });
    expect((await checkNoProgress(RUN, d)).checked).toBe(false);
    expect(d.writeHits).not.toHaveBeenCalled();
  });
});

describe("limitOfPolicy", () => {
  it("starts a workspace with no policy row at 20 in observe mode", () => {
    expect(limitOfPolicy(undefined)).toEqual({ repeats: 20, mode: "observe" });
    expect(NO_PROGRESS_DEFAULT_LIMIT).toEqual({ repeats: 20, mode: "observe" });
  });

  it("runs no check for a team that cleared its count", () => {
    expect(limitOfPolicy({ repeats: null, mode: "enforced" })).toBeNull();
  });

  it("keeps the limit a team set", () => {
    expect(limitOfPolicy({ repeats: 5, mode: "enforced" })).toEqual({
      repeats: 5,
      mode: "enforced",
    });
  });
});

describe("withDeclaredMutation", () => {
  it("takes a ledger call's write flag from its capability", () => {
    registry.getCapability.mockImplementation((name: string) =>
      name === "get_run_cost"
        ? { mutates: false }
        : name === "register_agent"
          ? {}
          : undefined,
    );
    const read = call({ name: "get_run_cost" });
    expect(withDeclaredMutation(read).isMutating).toBe(false);
    // A capability that does not declare `mutates: false` writes.
    expect(
      withDeclaredMutation(call({ name: "register_agent" })).isMutating,
    ).toBe(true);
    // A call the registry does not know keeps its null flag.
    expect(withDeclaredMutation(call({ name: "Bash" })).isMutating).toBeNull();
    // A flag the frame already carries is kept.
    expect(
      withDeclaredMutation(call({ name: "get_run_cost", isMutating: true }))
        .isMutating,
    ).toBe(true);
  });
});

describe("readNoProgressFrames", () => {
  it("reads a wrapped run's tool calls and file changes from its own sessions", async () => {
    const frames = [call(), { fileChanged: true as const }];
    readers.readTachoProgressFrames.mockResolvedValueOnce(frames);
    const source = {
      meta: { orgId: RUN.orgId, workspaceId: RUN.workspaceId },
      frames: {
        kind: "tacho",
        rootSessionUuid: "00000000-0000-4000-8000-0000000000aa",
        sessionUuids: ["00000000-0000-4000-8000-0000000000aa"],
      },
    } as unknown as RunSource;
    expect(await readNoProgressFrames(source)).toBe(frames);
    expect(readers.readTachoProgressFrames).toHaveBeenCalledWith({
      orgId: RUN.orgId,
      workspaceId: RUN.workspaceId,
      rootSessionUuid: "00000000-0000-4000-8000-0000000000aa",
      sessionUuids: ["00000000-0000-4000-8000-0000000000aa"],
    });
    expect(readers.readRunToolCalls).not.toHaveBeenCalled();
  });

  it("reads a ledger run's tool calls, which carry its file changes", async () => {
    registry.getCapability.mockReturnValue(undefined);
    const calls = times(3);
    readers.readRunToolCalls.mockResolvedValueOnce(calls);
    const source = {
      meta: { orgId: RUN.orgId, workspaceId: RUN.workspaceId },
      frames: {
        kind: "ledger",
        runUuid: "00000000-0000-4000-8000-0000000000cc",
      },
    } as unknown as RunSource;
    expect(await readNoProgressFrames(source)).toEqual(calls);
    expect(readers.readRunToolCalls).toHaveBeenCalledWith(source);
  });

  it("records one hit for a ledger run with 20 identical read-only capability calls at a limit of 20 (#4503)", async () => {
    registry.getCapability.mockImplementation((name: string) =>
      name === "list_runs" ? { mutates: false } : undefined,
    );
    readers.readRunToolCalls.mockResolvedValueOnce(
      Array.from({ length: 20 }, () =>
        call({
          name: "list_runs",
          inputDigest: "sha256:first-page",
          outputDigest: "sha256:same-runs",
        }),
      ),
    );
    const ledger = {
      meta: { orgId: RUN.orgId, workspaceId: RUN.workspaceId },
      frames: {
        kind: "ledger",
        runUuid: "00000000-0000-4000-8000-0000000000cc",
      },
    } as unknown as RunSource;
    const { d, rows } = deps({ repeats: 20, mode: "observe" }, [], {
      loadRunSource: vi.fn(async () => ledger),
      readFrames: readNoProgressFrames,
    });
    const out = await checkNoProgress(
      { ...RUN, runId: "arun_0000000000000000000001" },
      d,
    );
    expect(out).toMatchObject({ checked: true, loops: 1, newLoops: 1 });
    expect([...rows.values()]).toEqual([
      expect.objectContaining({
        tool: "list_runs",
        repeats: 20,
        atCall: 20,
        outcome: "would_pause",
      }),
    ]);
  });
});
