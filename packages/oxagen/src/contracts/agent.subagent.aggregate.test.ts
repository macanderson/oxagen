import { describe, expect, it } from "vitest";
import { agentSubagentAggregate } from "./agent.subagent.aggregate";
import { getCapability } from "../registry";

const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 1_800_000

describe("agent.subagent.aggregate capability", () => {
  // ── input: required fanoutId ──────────────────────────────────────────────

  it("parses minimal input with only fanoutId", () => {
    const parsed = agentSubagentAggregate.input.parse({
      fanoutId: "fanout_abc123",
    });
    expect(parsed.fanoutId).toBe("fanout_abc123");
  });

  it("rejects input missing fanoutId", () => {
    expect(() => agentSubagentAggregate.input.parse({})).toThrow();
  });

  it("rejects wrong type for fanoutId", () => {
    expect(() =>
      agentSubagentAggregate.input.parse({ fanoutId: 99 }),
    ).toThrow();
  });

  // ── input: timeoutMs defaults and bounds ──────────────────────────────────

  it("defaults timeoutMs to 300000 (5 min)", () => {
    const parsed = agentSubagentAggregate.input.parse({
      fanoutId: "fanout_abc",
    });
    expect(parsed.timeoutMs).toBe(5 * 60 * 1000);
  });

  it("accepts timeoutMs=0 (min)", () => {
    const parsed = agentSubagentAggregate.input.parse({
      fanoutId: "fanout_abc",
      timeoutMs: 0,
    });
    expect(parsed.timeoutMs).toBe(0);
  });

  it("accepts timeoutMs at max (30 min)", () => {
    const parsed = agentSubagentAggregate.input.parse({
      fanoutId: "fanout_abc",
      timeoutMs: MAX_TIMEOUT_MS,
    });
    expect(parsed.timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("rejects timeoutMs=-1 (below min)", () => {
    expect(() =>
      agentSubagentAggregate.input.parse({
        fanoutId: "fanout_abc",
        timeoutMs: -1,
      }),
    ).toThrow();
  });

  it("rejects timeoutMs above max", () => {
    expect(() =>
      agentSubagentAggregate.input.parse({
        fanoutId: "fanout_abc",
        timeoutMs: MAX_TIMEOUT_MS + 1,
      }),
    ).toThrow();
  });

  it("rejects a non-integer timeoutMs", () => {
    expect(() =>
      agentSubagentAggregate.input.parse({
        fanoutId: "fanout_abc",
        timeoutMs: 1000.5,
      }),
    ).toThrow();
  });

  // ── output: status enum ───────────────────────────────────────────────────

  it("accepts status='completed'", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "completed",
      totalChildren: 3,
      completedChildren: 3,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.status).toBe("completed");
  });

  it("accepts status='partial'", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "partial",
      totalChildren: 3,
      completedChildren: 2,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.status).toBe("partial");
  });

  it("accepts status='failed'", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "failed",
      totalChildren: 1,
      completedChildren: 0,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: "Something broke",
    });
    expect(parsed.status).toBe("failed");
    expect(parsed.firstError).toBe("Something broke");
  });

  it("accepts status='timed_out'", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "timed_out",
      totalChildren: 5,
      completedChildren: 2,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.status).toBe("timed_out");
  });

  it("rejects an unknown status", () => {
    expect(() =>
      agentSubagentAggregate.output.parse({
        fanoutId: "fanout_abc",
        status: "queued",
        totalChildren: 1,
        completedChildren: 0,
        aggregatedData: null,
        conflicts: [],
        timeline: [],
        children: [],
        aggregatedDataTruncated: false,
        recheckAfterMs: null,
        firstError: null,
      }),
    ).toThrow();
  });

  // ── output: aggregatedData nullable ───────────────────────────────────────

  it("accepts aggregatedData as null", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "completed",
      totalChildren: 1,
      completedChildren: 1,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.aggregatedData).toBeNull();
  });

  it("accepts aggregatedData as a populated record", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "completed",
      totalChildren: 2,
      completedChildren: 2,
      aggregatedData: { summary: "merged", count: 42 },
      conflicts: [],
      timeline: [],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.aggregatedData).toEqual({ summary: "merged", count: 42 });
  });

  // ── output: conflicts array ───────────────────────────────────────────────

  it("parses conflicts with multiple values", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "partial",
      totalChildren: 2,
      completedChildren: 2,
      aggregatedData: null,
      conflicts: [
        { key: "title", values: ["A", "B"], runIds: ["run_1", "run_2"] },
      ],
      timeline: [],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.conflicts).toHaveLength(1);
    expect(parsed.conflicts[0]?.key).toBe("title");
    expect(parsed.conflicts[0]?.values).toEqual(["A", "B"]);
  });

  // ── output: timeline array ────────────────────────────────────────────────

  it("parses a timeline with nullable date fields", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "completed",
      totalChildren: 1,
      completedChildren: 1,
      aggregatedData: null,
      conflicts: [],
      timeline: [
        {
          runId: "run_1",
          capabilityName: "execute_code",
          status: "completed",
          startedAt: "2024-01-01T00:00:00.000Z",
          completedAt: "2024-01-01T00:00:01.000Z",
          errorReason: null,
        },
      ],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.timeline).toHaveLength(1);
    expect(parsed.timeline[0]?.errorReason).toBeNull();
    expect(parsed.timeline[0]?.startedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("parses a timeline entry with null startedAt and completedAt", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "partial",
      totalChildren: 1,
      completedChildren: 0,
      aggregatedData: null,
      conflicts: [],
      timeline: [
        {
          runId: "run_1",
          capabilityName: "execute_code",
          status: "running",
          startedAt: null,
          completedAt: null,
          errorReason: null,
        },
      ],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.timeline[0]?.startedAt).toBeNull();
    expect(parsed.timeline[0]?.completedAt).toBeNull();
  });

  // ── output: firstError nullable ───────────────────────────────────────────

  it("parses firstError as null when successful", () => {
    const parsed = agentSubagentAggregate.output.parse({
      fanoutId: "fanout_abc",
      status: "completed",
      totalChildren: 1,
      completedChildren: 1,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      aggregatedDataTruncated: false,
      recheckAfterMs: null,
      firstError: null,
    });
    expect(parsed.firstError).toBeNull();
  });

  // ── output: invalid cases ─────────────────────────────────────────────────

  it("rejects output missing totalChildren", () => {
    expect(() =>
      agentSubagentAggregate.output.parse({
        fanoutId: "fanout_abc",
        status: "completed",
        completedChildren: 1,
        aggregatedData: null,
        conflicts: [],
        timeline: [],
        children: [],
        aggregatedDataTruncated: false,
        recheckAfterMs: null,
        firstError: null,
      }),
    ).toThrow();
  });

  it("rejects output with non-null non-record aggregatedData", () => {
    expect(() =>
      agentSubagentAggregate.output.parse({
        fanoutId: "fanout_abc",
        status: "completed",
        totalChildren: 1,
        completedChildren: 1,
        aggregatedData: "not-a-record",
        conflicts: [],
        timeline: [],
        children: [],
        aggregatedDataTruncated: false,
        recheckAfterMs: null,
        firstError: null,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("aggregate_subagents")).toBe(agentSubagentAggregate);
  });
});
