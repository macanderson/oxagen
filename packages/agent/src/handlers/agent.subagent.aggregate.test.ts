import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Module mocks -----------------------------------------------------------

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: vi.fn(),
  };
});

import { withTenantDb } from "@oxagen/database";
import { agentSubagentAggregateHandler } from "./agent.subagent.aggregate";
import type { AgentSubagentAggregateInput } from "./agent.subagent.aggregate";
import { FanoutNotFoundError } from "./subagent-errors";

// ---- Test helpers -----------------------------------------------------------

import { TEST_CTX as CTX } from "../test-utils/fixtures";

type FanoutRow = {
  id: string;
  publicId: string;
  status: string;
  totalChildren: number;
  completedChildren: number;
  createdAt: Date | null;
};
type RunRow = {
  publicId: string;
  capabilityName: string;
  status: string;
  inputPayload: Record<string, unknown> | null;
  outputPayload: Record<string, unknown> | null;
  summary: string | null;
  errorReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

function fanout(overrides: Partial<FanoutRow> = {}): FanoutRow {
  return {
    id: "fanuuid_1",
    publicId: "fan_1",
    status: "completed",
    totalChildren: 2,
    completedChildren: 2,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

function run(
  id: string,
  output: Record<string, unknown> | null,
  overrides: Partial<RunRow> = {},
): RunRow {
  return {
    publicId: id,
    capabilityName: "test.cap",
    status: "completed",
    inputPayload: { taskId: id },
    outputPayload: output,
    summary: null,
    errorReason: null,
    startedAt: new Date("2024-01-01T00:00:00Z"),
    completedAt: new Date("2024-01-01T00:01:00Z"),
    ...overrides,
  };
}

// The handler is called through the kernel in production, which applies the
// contract's zod defaults — calling it directly here means supplying them.
function aggInput(
  overrides: Partial<AgentSubagentAggregateInput> = {},
): AgentSubagentAggregateInput {
  return {
    fanoutId: "fan_1",
    timeoutMs: 1000,
    includeOutputs: false,
    includeMerged: false,
    ...overrides,
  };
}

// Set up withTenantDb to return fanoutRow on the first call, runRows on the second.
function setupMocks(fanoutRow: FanoutRow | null, runs: RunRow[]) {
  vi.mocked(withTenantDb)
    .mockImplementationOnce(async (fn) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (n: number) =>
                Promise.resolve(fanoutRow ? [fanoutRow].slice(0, n) : []),
            }),
          }),
        }),
      } as unknown as Parameters<typeof fn>[0]),
    )
    .mockImplementationOnce(async (fn) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(runs),
          }),
        }),
      } as unknown as Parameters<typeof fn>[0]),
    );
}

// ---- Tests ------------------------------------------------------------------

describe("agent.subagent.aggregate handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges non-conflicting outputs from all completed children when includeMerged is set", async () => {
    setupMocks(fanout(), [
      run("sar_1", { taskId: "t1", result: "ok" }),
      run("sar_2", { extra: 42 }),
    ]);

    const result = await agentSubagentAggregateHandler(
      aggInput({ includeMerged: true }),
      CTX,
    );

    expect(result.status).toBe("completed");
    expect(result.fanoutId).toBe("fan_1");
    expect(result.totalChildren).toBe(2);
    expect(result.completedChildren).toBe(2);
    expect(result.conflicts).toHaveLength(0);
    expect(result.aggregatedData).toMatchObject({
      taskId: "t1",
      result: "ok",
      extra: 42,
    });
    expect(result.aggregatedDataTruncated).toBe(false);
    expect(result.firstError).toBeNull();
    expect(result.timeline).toHaveLength(2);
  });

  it("compact default: children carry runId + summary + outputBytes, never payloads", async () => {
    setupMocks(fanout(), [
      run("sar_1", { results: ["a"] }, { summary: "1 hit for q1" }),
      run("sar_2", { results: ["b"] }),
    ]);

    const result = await agentSubagentAggregateHandler(aggInput(), CTX);

    expect(result.children).toHaveLength(2);
    // Stored summary wins; the runId is the ref for agent.subagent.result.get.
    expect(result.children[0]).toMatchObject({
      runId: "sar_1",
      status: "completed",
      summary: "1 hit for q1",
    });
    // No stored summary → structural fallback (JSON truncation of the output).
    expect(result.children[1]?.summary).toBe(
      JSON.stringify({ results: ["b"] }),
    );
    expect(result.children[0]?.outputBytes).toBeGreaterThan(0);
    // The whole point: full payloads are NOT relayed in compact mode.
    for (const child of result.children) {
      expect(child).not.toHaveProperty("input");
      expect(child).not.toHaveProperty("output");
    }
    // aggregatedData is opt-in now; conflicts are still computed server-side.
    expect(result.aggregatedData).toBeNull();
    expect(result.aggregatedDataTruncated).toBe(false);
  });

  it("compact fallback summary prefers a declared summary/message/text field", async () => {
    setupMocks(fanout({ totalChildren: 3 }), [
      run("sar_1", { summary: "  did the thing  ", noise: "x".repeat(500) }),
      run("sar_2", { message: "msg wins", other: 1 }),
      run("sar_3", null, {
        status: "failed",
        errorReason: "boom",
        outputPayload: null,
      }),
    ]);

    const result = await agentSubagentAggregateHandler(aggInput(), CTX);

    expect(result.children[0]?.summary).toBe("did the thing");
    expect(result.children[1]?.summary).toBe("msg wins");
    // Failed child with no output → error reason as the digest.
    expect(result.children[2]?.summary).toBe("boom");
  });

  it("legacy includeOutputs returns per-child full input + output (not merged)", async () => {
    setupMocks(fanout(), [
      run("sar_1", { results: ["a"] }, { inputPayload: { query: "q1" } }),
      run("sar_2", { results: ["b"] }, { inputPayload: { query: "q2" } }),
    ]);

    const result = await agentSubagentAggregateHandler(
      aggInput({ includeOutputs: true }),
      CTX,
    );

    expect(result.children).toHaveLength(2);
    // Each child preserves its DISTINCT input + output — no collision on `results`.
    expect(result.children[0]).toMatchObject({
      runId: "sar_1",
      input: { query: "q1" },
      output: { results: ["a"] },
      status: "completed",
    });
    expect(result.children[1]).toMatchObject({
      input: { query: "q2" },
      output: { results: ["b"] },
    });
    expect(result.children[0]).not.toHaveProperty("outputTruncated");
  });

  it("legacy includeOutputs caps an oversized child output and flags outputTruncated", async () => {
    const huge = { blob: "x".repeat(20_000) }; // ~20KB > 8KB cap
    setupMocks(fanout({ totalChildren: 1 }), [run("sar_1", huge)]);

    const result = await agentSubagentAggregateHandler(
      aggInput({ includeOutputs: true }),
      CTX,
    );

    const child = result.children[0];
    expect(child?.outputTruncated).toBe(true);
    expect(typeof child?.output).toBe("string");
    expect((child?.output as string).length).toBeLessThan(10_000);
    // outputBytes still reports the FULL size so callers know what result.get returns.
    expect(child?.outputBytes).toBeGreaterThan(20_000);
  });

  it("includeMerged over the cap returns null aggregatedData + aggregatedDataTruncated", async () => {
    setupMocks(fanout(), [
      run("sar_1", { a: "x".repeat(10_000) }),
      run("sar_2", { b: "y".repeat(10_000) }),
    ]);

    const result = await agentSubagentAggregateHandler(
      aggInput({ includeMerged: true }),
      CTX,
    );

    expect(result.aggregatedData).toBeNull();
    expect(result.aggregatedDataTruncated).toBe(true);
    // conflicts still flow — they are tiny and always useful.
    expect(result.conflicts).toHaveLength(0);
  });

  it("detects conflicts when two runs produce different values for the same key", async () => {
    setupMocks(fanout(), [
      run("sar_1", { shared: "valueA" }),
      run("sar_2", { shared: "valueB" }),
    ]);

    const result = await agentSubagentAggregateHandler(
      aggInput({ includeMerged: true }),
      CTX,
    );

    expect(result.status).toBe("completed");
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict).toBeDefined();
    expect(conflict?.key).toBe("shared");
    expect(conflict?.values).toContain("valueA");
    expect(conflict?.values).toContain("valueB");
    expect(result.aggregatedData).not.toHaveProperty("shared");
  });

  it("computes conflicts even in compact mode when includeMerged is false", async () => {
    // The contract promises conflicts[] is "always computed and returned
    // regardless" of includeMerged — conflict detection is gated on the
    // mergeable status, NOT on includeMerged. Guards against a regression that
    // accidentally hides conflicts behind the opt-in merge flag.
    setupMocks(fanout(), [
      run("sar_1", { shared: "valueA" }),
      run("sar_2", { shared: "valueB" }),
    ]);

    const result = await agentSubagentAggregateHandler(aggInput(), CTX); // includeMerged defaults false

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.key).toBe("shared");
    expect(result.conflicts[0]?.values).toEqual(
      expect.arrayContaining(["valueA", "valueB"]),
    );
    // Still compact: the merged record itself is withheld without includeMerged.
    expect(result.aggregatedData).toBeNull();
    expect(result.aggregatedDataTruncated).toBe(false);
    // …and children stay payload-free.
    for (const child of result.children) {
      expect(child).not.toHaveProperty("output");
    }
  });

  it("no conflict when two runs produce the same value for the same key", async () => {
    setupMocks(fanout(), [
      run("sar_1", { color: "blue" }),
      run("sar_2", { color: "blue" }),
    ]);

    const result = await agentSubagentAggregateHandler(
      aggInput({ includeMerged: true }),
      CTX,
    );

    expect(result.conflicts).toHaveLength(0);
    expect(result.aggregatedData).toMatchObject({ color: "blue" });
  });

  it("reports 'partial' (not 'failed') with merged data + firstError when some succeed and some fail", async () => {
    setupMocks(fanout({ status: "partial" }), [
      run("sar_1", { result: "ok" }),
      run("sar_2", null, {
        status: "failed",
        errorReason: "OOM error",
        outputPayload: null,
      }),
    ]);

    const result = await agentSubagentAggregateHandler(
      aggInput({ includeMerged: true }),
      CTX,
    );

    // Distinct from "failed": a mixed outcome surfaces the successful subset.
    expect(result.status).toBe("partial");
    expect(result.firstError).toBe("OOM error");
    expect(result.aggregatedData).toMatchObject({ result: "ok" });
    // Terminal status → no recheck hint.
    expect(result.recheckAfterMs).toBeNull();
  });

  it("reports 'failed' only when every child failed (zero completed)", async () => {
    setupMocks(fanout({ status: "partial", completedChildren: 0 }), [
      run("sar_1", null, {
        status: "failed",
        errorReason: "boom",
        outputPayload: null,
      }),
      run("sar_2", null, {
        status: "failed",
        errorReason: "second",
        outputPayload: null,
      }),
    ]);

    const result = await agentSubagentAggregateHandler(
      aggInput({ includeMerged: true }),
      CTX,
    );

    expect(result.status).toBe("failed");
    expect(result.firstError).toBe("boom");
    expect(result.aggregatedData).toBeNull();
  });

  it("returns 'running' immediately with NO children and a recheck hint (compact short-circuit)", async () => {
    // createdAt is recent, so the snapshot window has not elapsed.
    setupMocks(
      fanout({
        status: "running",
        completedChildren: 1,
        createdAt: new Date(),
      }),
      [
        // One completed child took 60s → median 60s → clamped to the 60s max.
        run("sar_1", { a: 1 }),
        run("sar_2", null, {
          status: "running",
          outputPayload: null,
          completedAt: null,
        }),
      ],
    );

    const started = Date.now();
    const result = await agentSubagentAggregateHandler(
      aggInput({ timeoutMs: 30 * 60 * 1000 }),
      CTX,
    );
    // Must return without sleeping for the timeout window.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.status).toBe("running");
    expect(result.aggregatedData).toBeNull();
    // Mid-flight compact mode: counts + recheck only — a poll costs ~nothing.
    expect(result.children).toHaveLength(0);
    expect(result.recheckAfterMs).toBe(60_000);
    // Timeline still carries live per-child status for viewers (payload-free).
    expect(result.timeline).toHaveLength(2);
  });

  it("clamps recheckAfterMs UP to the 5s floor for very fast children", async () => {
    // The 60s-max clamp is covered above; this guards the RECHECK_MIN_MS floor.
    // A completed child that took only 1s yields a 1000ms median, which must be
    // clamped up to the 5s minimum so callers never tight-poll sub-second.
    setupMocks(
      fanout({
        status: "running",
        completedChildren: 1,
        createdAt: new Date(),
      }),
      [
        run(
          "sar_1",
          { a: 1 },
          {
            startedAt: new Date("2024-01-01T00:00:00.000Z"),
            completedAt: new Date("2024-01-01T00:00:01.000Z"), // 1s
          },
        ),
        run("sar_2", null, {
          status: "running",
          outputPayload: null,
          completedAt: null,
        }),
      ],
    );

    const result = await agentSubagentAggregateHandler(
      aggInput({ timeoutMs: 30 * 60 * 1000 }),
      CTX,
    );

    expect(result.status).toBe("running");
    expect(result.recheckAfterMs).toBe(5_000);
  });

  it("returns 'running' with default recheck hint when no child has completed yet", async () => {
    setupMocks(
      fanout({
        status: "running",
        completedChildren: 0,
        createdAt: new Date(),
      }),
      [
        run("sar_1", null, {
          status: "running",
          outputPayload: null,
          completedAt: null,
        }),
        run("sar_2", null, {
          status: "pending",
          outputPayload: null,
          startedAt: null,
          completedAt: null,
        }),
      ],
    );

    const result = await agentSubagentAggregateHandler(
      aggInput({ timeoutMs: 30 * 60 * 1000 }),
      CTX,
    );

    expect(result.status).toBe("running");
    expect(result.recheckAfterMs).toBe(15_000);
    expect(result.children).toHaveLength(0);
  });

  it("includeOutputs preserves progressive children while running", async () => {
    // research.swarm.status streams per-query hits as they land — includeOutputs
    // mode must keep returning children mid-flight.
    setupMocks(
      fanout({
        status: "running",
        completedChildren: 1,
        createdAt: new Date(),
      }),
      [
        run("sar_1", { results: ["a"] }, { inputPayload: { query: "q1" } }),
        run("sar_2", null, {
          status: "running",
          outputPayload: null,
          completedAt: null,
        }),
      ],
    );

    const result = await agentSubagentAggregateHandler(
      aggInput({ timeoutMs: 30 * 60 * 1000, includeOutputs: true }),
      CTX,
    );

    expect(result.status).toBe("running");
    expect(result.children).toHaveLength(2);
    expect(result.children[0]).toMatchObject({
      input: { query: "q1" },
      output: { results: ["a"] },
    });
  });

  it("reports a LIVE completedChildren from runs, not the stale fanout column (progress-bar regression)", async () => {
    // The executor only writes fanout.completedChildren in its final `finalize`
    // step, so an in-flight fanout's column is 0 even as children finish.
    // research.swarm.status surfaces completedChildren as the progress numerator,
    // so reading the stale column pinned the bar at 0% until the swarm ended.
    // The aggregate must report the live count derived from the run rows.
    setupMocks(
      fanout({
        status: "running",
        completedChildren: 0,
        totalChildren: 3,
        createdAt: new Date(),
      }),
      [
        run("sar_1", { a: 1 }),
        run("sar_2", { b: 2 }),
        run("sar_3", null, {
          status: "running",
          outputPayload: null,
          completedAt: null,
        }),
      ],
    );

    const result = await agentSubagentAggregateHandler(
      aggInput({ timeoutMs: 30 * 60 * 1000 }),
      CTX,
    );

    expect(result.status).toBe("running");
    expect(result.completedChildren).toBe(2); // live (2 of 3), despite fanout column = 0
    expect(result.totalChildren).toBe(3);
  });

  it("reports 'timed_out' for an in-progress fanout older than the snapshot window", async () => {
    setupMocks(
      fanout({
        status: "running",
        completedChildren: 1,
        createdAt: new Date("2020-01-01T00:00:00Z"),
      }),
      [
        run("sar_1", { a: 1 }),
        run("sar_2", null, {
          status: "running",
          outputPayload: null,
          completedAt: null,
        }),
      ],
    );

    const result = await agentSubagentAggregateHandler(aggInput(), CTX);

    expect(result.status).toBe("timed_out");
    expect(result.aggregatedData).toBeNull();
    // timed_out is terminal for this snapshot: compact children ARE returned
    // (what finished is actionable) and no recheck hint is suggested.
    expect(result.children).toHaveLength(2);
    expect(result.recheckAfterMs).toBeNull();
  });

  it("reports the true terminal status for a fanout stuck at 'pending' when every child is terminal", async () => {
    // Regression: when the executor never ran (e.g. the dispatch event was
    // emitted but no Inngest function picked it up), the fan-out row stays
    // `pending`. With every child already failed (dispatch emit marked them so),
    // a recent createdAt + large window must NOT report a misleading `running` —
    // it must surface `failed` immediately so the swarm fails loudly.
    setupMocks(
      fanout({
        status: "pending",
        completedChildren: 0,
        createdAt: new Date(),
      }),
      [
        run("sar_1", null, {
          status: "failed",
          errorReason: "dispatch emit failed: x",
          outputPayload: null,
        }),
        run("sar_2", null, {
          status: "failed",
          errorReason: "dispatch emit failed: x",
          outputPayload: null,
        }),
      ],
    );

    const result = await agentSubagentAggregateHandler(
      aggInput({ timeoutMs: 30 * 60 * 1000 }),
      CTX,
    );

    expect(result.status).toBe("failed");
    expect(result.firstError).toBe("dispatch emit failed: x");
  });

  it("reports 'completed' for a fanout stuck at 'pending' when every child already completed", async () => {
    // The executor finished the children but never advanced the fan-out row
    // (e.g. it crashed before mark-complete). All children completed → completed.
    setupMocks(
      fanout({
        status: "pending",
        completedChildren: 2,
        createdAt: new Date(),
      }),
      [run("sar_1", { a: 1 }), run("sar_2", { b: 2 })],
    );

    const result = await agentSubagentAggregateHandler(
      aggInput({ timeoutMs: 30 * 60 * 1000, includeMerged: true }),
      CTX,
    );

    expect(result.status).toBe("completed");
    expect(result.aggregatedData).toMatchObject({ a: 1, b: 2 });
  });

  it("throws a typed FanoutNotFoundError when the fanout is not found", async () => {
    setupMocks(null, []);

    // Typed error (not a plain Error) so surfaces can map an unknown / cross-tenant
    // fanout id to a 404 via instanceof rather than a brittle message regex.
    // Capture the rejection ONCE (setupMocks arms the query mock for a single
    // call) and assert both the type and the message off the same error.
    const err = await agentSubagentAggregateHandler(
      aggInput({ fanoutId: "fan_missing", timeoutMs: 100 }),
      CTX,
    ).then(
      () => {
        throw new Error("expected handler to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FanoutNotFoundError);
    expect((err as FanoutNotFoundError).code).toBe("fanout_not_found");
    expect((err as Error).message).toBe("Fanout fan_missing not found");
  });
});
