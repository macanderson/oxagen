import { describe, expect, it } from "vitest";
import { lineageQuery } from "./lineage.query";
import { getCapability } from "../registry";

const VALID_NODE = {
  runId: "sar_1",
  fanoutId: "fan_root",
  parentRunId: null,
  childFanoutId: null,
  depth: 0,
  capabilityName: "read_file",
  outcome: "completed" as const,
  attempts: 1,
  principal: {
    id: "prn_1",
    kind: "agent" as const,
    displayName: "Research Agent",
  },
  delegationCeiling: { principalId: "prn_human_1", displayName: "Jane Doe" },
  model: "claude-sonnet-5",
  provider: "anthropic",
  spend: { costUsd: 0.42, inputTokens: 1000, outputTokens: 500, llmCalls: 2 },
  delegationViolation: null,
  startedAt: "2026-07-21T00:00:00.000Z",
  completedAt: "2026-07-21T00:00:05.000Z",
  durationMs: 5000,
};

describe("lineage.query capability", () => {
  it("is registered under query_lineage — verb-first snake_case (ADR-025)", () => {
    expect(lineageQuery.name).toBe("query_lineage");
    expect(getCapability("query_lineage")).toBe(lineageQuery);
  });

  it("is org/workspace scoped, low-risk, read-only", () => {
    expect(lineageQuery.domain).toBe("lineage");
    expect(lineageQuery.scoped).toBe(true);
    expect(lineageQuery.mode).toBe("sync");
    expect(lineageQuery.agent?.riskLevel).toBe("low");
    expect(lineageQuery.agent?.requiresApproval).toBe(false);
  });

  it("declares every required surface, including agent (the app page invokes via surface: agent)", () => {
    expect(lineageQuery.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
  });

  it("declares the layers the issue requires", () => {
    expect(lineageQuery.layers).toEqual([
      "schema",
      "api",
      "docs",
      "mcp",
      "unit",
      "app",
    ]);
  });

  it("defaults to deny with org Owner/Admin and workspace Owner/Member/Viewer allowed to read", () => {
    expect(lineageQuery.defaultEffect).toBe("deny");
    expect(lineageQuery.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
    });
  });

  describe("input", () => {
    it("requires a non-empty dispatchId", () => {
      expect(() => lineageQuery.input.parse({ dispatchId: "" })).toThrow();
      expect(() => lineageQuery.input.parse({})).toThrow();
    });

    it("applies maxDepth/maxNodes defaults", () => {
      const parsed = lineageQuery.input.parse({ dispatchId: "fan_abc" });
      expect(parsed).toEqual({
        dispatchId: "fan_abc",
        maxDepth: 5,
        maxNodes: 200,
      });
    });

    it("accepts explicit maxDepth/maxNodes within bounds", () => {
      const parsed = lineageQuery.input.parse({
        dispatchId: "fan_abc",
        maxDepth: 8,
        maxNodes: 50,
      });
      expect(parsed.maxDepth).toBe(8);
      expect(parsed.maxNodes).toBe(50);
    });

    it("rejects maxDepth/maxNodes outside their bounds", () => {
      expect(() =>
        lineageQuery.input.parse({ dispatchId: "fan_abc", maxDepth: 0 }),
      ).toThrow();
      expect(() =>
        lineageQuery.input.parse({ dispatchId: "fan_abc", maxDepth: 11 }),
      ).toThrow();
      expect(() =>
        lineageQuery.input.parse({ dispatchId: "fan_abc", maxNodes: 0 }),
      ).toThrow();
      expect(() =>
        lineageQuery.input.parse({ dispatchId: "fan_abc", maxNodes: 501 }),
      ).toThrow();
    });
  });

  describe("output", () => {
    function baseOutput(overrides: Record<string, unknown> = {}) {
      return {
        dispatchId: "fan_root",
        rootStatus: "completed" as const,
        totalChildren: 1,
        completedChildren: 1,
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:06.000Z",
        nodes: [VALID_NODE],
        nodeCount: 1,
        truncated: false,
        maxDepthReached: false,
        ...overrides,
      };
    }

    it("parses a full single-node tree", () => {
      const parsed = lineageQuery.output.parse(baseOutput());
      expect(parsed.nodes).toHaveLength(1);
      expect(parsed.nodes[0]!.runId).toBe("sar_1");
    });

    it("parses an empty tree (no children yet)", () => {
      const parsed = lineageQuery.output.parse(
        baseOutput({
          nodes: [],
          nodeCount: 0,
          totalChildren: 0,
          completedChildren: 0,
        }),
      );
      expect(parsed.nodes).toEqual([]);
    });

    it("parses a node with a null principal and null delegationCeiling", () => {
      const parsed = lineageQuery.output.parse(
        baseOutput({
          nodes: [
            {
              ...VALID_NODE,
              principal: {
                id: null,
                kind: null,
                displayName: "Unknown principal",
              },
              delegationCeiling: null,
              model: null,
              provider: null,
            },
          ],
        }),
      );
      expect(parsed.nodes[0]!.principal.id).toBeNull();
      expect(parsed.nodes[0]!.delegationCeiling).toBeNull();
    });

    it("parses a node carrying a delegationViolation", () => {
      const parsed = lineageQuery.output.parse(
        baseOutput({
          nodes: [
            {
              ...VALID_NODE,
              outcome: "failed",
              delegationViolation: {
                ruleId: "no_grant",
                message:
                  'IAM denied "run_capability_chain" for principal: no_grant',
              },
            },
          ],
        }),
      );
      expect(parsed.nodes[0]!.delegationViolation).toEqual({
        ruleId: "no_grant",
        message: 'IAM denied "run_capability_chain" for principal: no_grant',
      });
    });

    it("accepts every outcome value, including cancelled (distinct from failed)", () => {
      for (const outcome of [
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
      ] as const) {
        expect(() =>
          lineageQuery.output.parse(
            baseOutput({ nodes: [{ ...VALID_NODE, outcome }] }),
          ),
        ).not.toThrow();
      }
    });

    it("rejects an unknown outcome", () => {
      expect(() =>
        lineageQuery.output.parse(
          baseOutput({
            nodes: [{ ...VALID_NODE, outcome: "cancelled_by_mistake" }],
          }),
        ),
      ).toThrow();
    });

    it("rejects an unknown rootStatus (no 'cancelled' — the fanout CHECK constraint has no such value)", () => {
      expect(() =>
        lineageQuery.output.parse(baseOutput({ rootStatus: "cancelled" })),
      ).toThrow();
    });
  });
});
