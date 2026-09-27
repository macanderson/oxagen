// no-progress-store.test.ts — the no-progress check over one run, with the
// stores faked (spend spec, detector 1; #4490).
import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/database", () => ({
  schema: {},
  withSystemDb: vi.fn(() => {
    throw new Error("the check must not reach the database in this test");
  }),
}));
vi.mock("./cost-rollup-store", () => ({
  loadRunSource: vi.fn(),
  readRunToolCalls: vi.fn(),
}));

import type { RunSource } from "./cost-rollup-store";
import type { ToolCallFrame } from "./cost-rollup";
import type { NoProgressLimit } from "./no-progress";
import {
  checkNoProgress,
  loopKeyOf,
  type NoProgressDeps,
  type NoProgressHit,
  type NoProgressRun,
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
  calls: ToolCallFrame[],
  over: Partial<NoProgressDeps> = {},
) {
  const store = fakeHits();
  const d: NoProgressDeps = {
    now: () => NOW,
    readLimit: vi.fn(async () => limit),
    loadRunSource: vi.fn(async () => SOURCE),
    readToolCalls: vi.fn(async () => calls),
    readRecorded: store.readRecorded,
    writeHits: store.writeHits,
    pauseRun: null,
    ...over,
  };
  return { d, rows: store.rows };
}

describe("checkNoProgress", () => {
  it("records one hit for 20 identical calls at a limit of 20 in observe mode, and lets the run continue", async () => {
    const pauseRun = vi.fn(async () => true);
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
      },
    ]);
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
    const pauseRun = vi.fn(async () => true);
    const calls = times(20);
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, calls, {
      pauseRun,
    });
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ newLoops: 1, paused: true });
    expect(pauseRun).toHaveBeenCalledTimes(1);
    expect(pauseRun).toHaveBeenCalledWith(RUN);
    expect([...rows.values()][0]).toMatchObject({
      mode: "enforced",
      outcome: "paused",
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

  it("records would_pause in enforced mode when the pause path is not reachable", async () => {
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, times(20));
    const out = await checkNoProgress(RUN, d);
    expect(out).toMatchObject({ newLoops: 1, paused: false });
    expect([...rows.values()][0]).toMatchObject({
      mode: "enforced",
      outcome: "would_pause",
    });
  });

  it("records would_pause when the pause is refused", async () => {
    const pauseRun = vi.fn(async () => false);
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, times(20), {
      pauseRun,
    });
    await checkNoProgress(RUN, d);
    expect(pauseRun).toHaveBeenCalledTimes(1);
    expect([...rows.values()][0]?.outcome).toBe("would_pause");
  });

  it("does not pause a sealed run", async () => {
    const pauseRun = vi.fn(async () => true);
    const { d, rows } = deps({ repeats: 20, mode: "enforced" }, times(20), {
      pauseRun,
    });
    await checkNoProgress({ ...RUN, sealed: true }, d);
    expect(pauseRun).not.toHaveBeenCalled();
    expect([...rows.values()][0]?.outcome).toBe("would_pause");
  });

  it("records no hit and reads no calls for a workspace with no count", async () => {
    const { d } = deps(null, times(40));
    const out = await checkNoProgress(RUN, d);
    expect(out).toEqual({
      checked: false,
      loops: 0,
      newLoops: 0,
      paused: false,
    });
    expect(d.loadRunSource).not.toHaveBeenCalled();
    expect(d.readToolCalls).not.toHaveBeenCalled();
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
    expect(d.readToolCalls).not.toHaveBeenCalled();
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
