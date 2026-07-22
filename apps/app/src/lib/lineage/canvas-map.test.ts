import { describe, it, expect } from "vitest";
import {
  mapLineageToCanvas,
  colorForLineageNode,
  sizeForLineageNode,
  LINEAGE_ROOT_NODE_ID,
} from "./canvas-map";
import type { LineageNodeDto } from "@oxagen/oxagen/contracts/lineage.query";

function node(
  overrides: Partial<LineageNodeDto> & { runId: string },
): LineageNodeDto {
  return {
    fanoutId: "fanout-1",
    parentRunId: null,
    childFanoutId: null,
    depth: 0,
    capabilityName: "search_web",
    outcome: "completed",
    attempts: 1,
    principal: { id: "p1", kind: "agent", displayName: "Ops Agent" },
    delegationCeiling: null,
    model: "claude-sonnet-5",
    provider: "anthropic",
    spend: { costUsd: 0, inputTokens: 0, outputTokens: 0, llmCalls: 0 },
    delegationViolation: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

describe("colorForLineageNode", () => {
  it("returns a distinct colour per outcome", () => {
    const colors = new Set(
      (["pending", "running", "completed", "failed", "cancelled"] as const).map(
        (o) => colorForLineageNode(o, false),
      ),
    );
    expect(colors.size).toBe(5);
  });

  it("overrides the outcome colour with the violation colour when violation=true", () => {
    const completedNormal = colorForLineageNode("completed", false);
    const completedViolation = colorForLineageNode("completed", true);
    const failedViolation = colorForLineageNode("failed", true);
    expect(completedViolation).not.toBe(completedNormal);
    // A violation is unmistakable regardless of which outcome it landed in —
    // and distinct from a plain `failed` node, so it never reads as an
    // ordinary failure.
    expect(completedViolation).toBe(failedViolation);
    const failedNormal = colorForLineageNode("failed", false);
    expect(failedViolation).not.toBe(failedNormal);
  });
});

describe("sizeForLineageNode", () => {
  it("returns a positive size for a zero-spend node", () => {
    const size = sizeForLineageNode(node({ runId: "a" }));
    expect(size).toBeGreaterThan(0);
  });

  it("grows with spend", () => {
    const cheap = sizeForLineageNode(
      node({
        runId: "a",
        spend: { costUsd: 0.01, inputTokens: 0, outputTokens: 0, llmCalls: 1 },
      }),
    );
    const expensive = sizeForLineageNode(
      node({
        runId: "b",
        spend: { costUsd: 5, inputTokens: 0, outputTokens: 0, llmCalls: 1 },
      }),
    );
    expect(expensive).toBeGreaterThan(cheap);
  });

  it("caps size at a maximum regardless of spend", () => {
    const huge = sizeForLineageNode(
      node({
        runId: "a",
        spend: {
          costUsd: 100_000,
          inputTokens: 0,
          outputTokens: 0,
          llmCalls: 1,
        },
      }),
    );
    expect(huge).toBeLessThanOrEqual(24);
  });

  it("bumps size for a delegation violation relative to the identical non-violating node", () => {
    const base = node({
      runId: "a",
      spend: { costUsd: 1, inputTokens: 0, outputTokens: 0, llmCalls: 1 },
    });
    const violating = {
      ...base,
      delegationViolation: { ruleId: "authz_denied", message: "denied" },
    };
    expect(sizeForLineageNode(violating)).toBeGreaterThan(
      sizeForLineageNode(base),
    );
  });
});

describe("mapLineageToCanvas", () => {
  it("always includes a synthetic root node anchoring the dispatch", () => {
    const { nodes } = mapLineageToCanvas([], "sfo_abc123");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe(LINEAGE_ROOT_NODE_ID);
    expect(nodes[0]?.label).toBe("Dispatch");
  });

  it("connects every depth-0 node (parentRunId=null) to the synthetic root", () => {
    const a = node({ runId: "a", parentRunId: null });
    const b = node({ runId: "b", parentRunId: null });
    const { edges } = mapLineageToCanvas([a, b], "sfo_abc");
    const aEdge = edges.find((e) => e.target === "a");
    const bEdge = edges.find((e) => e.target === "b");
    expect(aEdge?.source).toBe(LINEAGE_ROOT_NODE_ID);
    expect(bEdge?.source).toBe(LINEAGE_ROOT_NODE_ID);
  });

  it("connects a multi-level node to its resolved parent, not the root", () => {
    const root = node({ runId: "root", parentRunId: null, depth: 0 });
    const child = node({ runId: "child", parentRunId: "root", depth: 1 });
    const grandchild = node({ runId: "gc", parentRunId: "child", depth: 2 });
    const { edges } = mapLineageToCanvas([root, child, grandchild], "sfo_abc");

    expect(edges.find((e) => e.target === "child")?.source).toBe("root");
    expect(edges.find((e) => e.target === "gc")?.source).toBe("child");
    expect(edges.find((e) => e.target === "root")?.source).toBe(
      LINEAGE_ROOT_NODE_ID,
    );
  });

  it("falls back to the synthetic root when parentRunId points outside the result set", () => {
    const orphan = node({
      runId: "orphan",
      parentRunId: "not-in-this-batch",
      depth: 0,
    });
    const { edges } = mapLineageToCanvas([orphan], "sfo_abc");
    expect(edges.find((e) => e.target === "orphan")?.source).toBe(
      LINEAGE_ROOT_NODE_ID,
    );
  });

  it("never puts a runId in the node label — capabilityName is the label, principal is the subLabel", () => {
    const n = node({
      runId: "run-xyz-999",
      capabilityName: "dispatch_subagent",
      principal: { id: "p", kind: "human", displayName: "Jane Doe" },
    });
    const { nodes } = mapLineageToCanvas([n], "sfo_abc");
    const mapped = nodes.find((x) => x.id === "run-xyz-999");
    expect(mapped?.label).toBe("dispatch_subagent");
    expect(mapped?.subLabel).toBe("Jane Doe");
    expect(mapped?.label).not.toContain("run-xyz-999");
    expect(mapped?.subLabel).not.toContain("run-xyz-999");
  });

  it("flags a delegation-violation node with a ⚠ prefix on its subLabel and the violation colour", () => {
    const n = node({
      runId: "bad-run",
      principal: { id: "p", kind: "agent", displayName: "Rogue Agent" },
      delegationViolation: {
        ruleId: "authz_denied",
        message: 'IAM denied "x" for principal: nope',
      },
    });
    const { nodes } = mapLineageToCanvas([n], "sfo_abc");
    const mapped = nodes.find((x) => x.id === "bad-run");
    expect(mapped?.subLabel).toBe("⚠ Rogue Agent");
    expect(mapped?.fill).toBe(colorForLineageNode("completed", true));
    expect(mapped?.data.violation).toBe(true);
  });

  it("marks the edge into a violating node as dashed", () => {
    const root = node({ runId: "root" });
    const violating = node({
      runId: "bad",
      parentRunId: "root",
      delegationViolation: { ruleId: "authz_denied", message: "denied" },
    });
    const { edges } = mapLineageToCanvas([root, violating], "sfo_abc");
    expect(edges.find((e) => e.target === "bad")?.dashed).toBe(true);
    expect(edges.find((e) => e.target === "root")?.dashed).toBe(false);
  });

  it("produces one node + one edge per input node, plus the synthetic root", () => {
    const nodes = [
      node({ runId: "a" }),
      node({ runId: "b", parentRunId: "a", depth: 1 }),
      node({ runId: "c", parentRunId: "a", depth: 1 }),
    ];
    const { nodes: canvasNodes, edges } = mapLineageToCanvas(nodes, "sfo_abc");
    expect(canvasNodes).toHaveLength(4); // 3 real + 1 synthetic root
    expect(edges).toHaveLength(3);
  });

  it("produces distinct edge ids for a multi-level tree (no id collisions)", () => {
    const nodes = [
      node({ runId: "a" }),
      node({ runId: "b", parentRunId: "a", depth: 1 }),
      node({ runId: "c", parentRunId: "b", depth: 2 }),
    ];
    const { edges } = mapLineageToCanvas(nodes, "sfo_abc");
    const ids = edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
