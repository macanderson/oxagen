import { describe, expect, it } from "vitest";
import { agentSubagentSiblings } from "./agent.subagent.siblings";
import { getCapability } from "../registry";

describe("agent.subagent.siblings capability", () => {
  // ── registration ──────────────────────────────────────────────────────────

  it("is registered under its contract name", () => {
    expect(getCapability("list_subagent_siblings")).toBe(agentSubagentSiblings);
  });

  it("is a read-only sync capability on api/mcp/agent surfaces", () => {
    expect(agentSubagentSiblings.mode).toBe("sync");
    expect(agentSubagentSiblings.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(agentSubagentSiblings.agent?.requiresApproval).toBe(false);
    expect(agentSubagentSiblings.agent?.riskLevel).toBe("low");
    expect(agentSubagentSiblings.agent?.category).toBe("introspection");
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("parses input with runId", () => {
    const parsed = agentSubagentSiblings.input.parse({ runId: "sar_abc123" });
    expect(parsed.runId).toBe("sar_abc123");
  });

  it("rejects input missing runId", () => {
    expect(() => agentSubagentSiblings.input.parse({})).toThrow();
  });

  it("rejects a non-string runId", () => {
    expect(() => agentSubagentSiblings.input.parse({ runId: 42 })).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  const SIBLING = {
    runId: "sar_2",
    capabilityName: "search_web",
    status: "completed" as const,
    summary: "3 hits",
    attempts: 1,
    errorReason: null,
  };

  const BASE_OUTPUT = {
    runId: "sar_1",
    fanoutId: "fan_abc",
    siblings: [SIBLING],
  };

  it("parses an output with compact sibling rows", () => {
    const parsed = agentSubagentSiblings.output.parse(BASE_OUTPUT);
    expect(parsed.fanoutId).toBe("fan_abc");
    expect(parsed.siblings).toHaveLength(1);
    const [only] = parsed.siblings;
    expect(only?.runId).toBe("sar_2");
    expect(only?.attempts).toBe(1);
  });

  it("parses an empty siblings list", () => {
    const parsed = agentSubagentSiblings.output.parse({
      ...BASE_OUTPUT,
      siblings: [],
    });
    expect(parsed.siblings).toEqual([]);
  });

  it("parses siblings with null summary/errorReason and each status", () => {
    const parsed = agentSubagentSiblings.output.parse({
      ...BASE_OUTPUT,
      siblings: [
        { ...SIBLING, status: "pending", summary: null },
        { ...SIBLING, runId: "sar_3", status: "failed", errorReason: "boom" },
      ],
    });
    expect(parsed.siblings[0]?.summary).toBeNull();
    expect(parsed.siblings[1]?.errorReason).toBe("boom");
  });

  it("does NOT allow input/output payload fields on a sibling (compact by design)", () => {
    const parsed = agentSubagentSiblings.output.parse({
      ...BASE_OUTPUT,
      siblings: [{ ...SIBLING, input: { secret: 1 }, output: { secret: 2 } }],
    });
    // Zod strips unknown keys — payloads never survive the contract boundary.
    expect(parsed.siblings[0]).not.toHaveProperty("input");
    expect(parsed.siblings[0]).not.toHaveProperty("output");
  });

  it("rejects an unknown sibling status", () => {
    expect(() =>
      agentSubagentSiblings.output.parse({
        ...BASE_OUTPUT,
        siblings: [{ ...SIBLING, status: "exploded" }],
      }),
    ).toThrow();
  });

  it("rejects a non-integer attempts value", () => {
    expect(() =>
      agentSubagentSiblings.output.parse({
        ...BASE_OUTPUT,
        siblings: [{ ...SIBLING, attempts: 1.5 }],
      }),
    ).toThrow();
  });
});
