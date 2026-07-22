import { describe, it, expect } from "vitest";
import { buildLineageTree, summarizeLineage } from "./tree";
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

describe("buildLineageTree", () => {
  it("returns an empty forest for an empty node list", () => {
    expect(buildLineageTree([])).toEqual([]);
  });

  it("puts every depth-0 (parentRunId=null) node at the top level", () => {
    const a = node({ runId: "a", startedAt: "2026-01-01T00:00:00.000Z" });
    const b = node({ runId: "b", startedAt: "2026-01-01T00:01:00.000Z" });
    const tree = buildLineageTree([a, b]);
    expect(tree).toHaveLength(2);
    expect(tree.map((t) => t.node.runId)).toEqual(["a", "b"]);
    expect(tree[0]?.children).toEqual([]);
    expect(tree[1]?.children).toEqual([]);
  });

  it("nests multiple levels deep via parentRunId", () => {
    const root = node({ runId: "root", depth: 0 });
    const mid = node({ runId: "mid", parentRunId: "root", depth: 1 });
    const leaf = node({ runId: "leaf", parentRunId: "mid", depth: 2 });
    const tree = buildLineageTree([root, mid, leaf]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.node.runId).toBe("root");
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.node.runId).toBe("mid");
    expect(tree[0]?.children[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.children[0]?.node.runId).toBe("leaf");
  });

  it("attaches multiple children to the same parent, each with their own subtree", () => {
    const root = node({ runId: "root" });
    const c1 = node({
      runId: "c1",
      parentRunId: "root",
      startedAt: "2026-01-01T00:00:01.000Z",
    });
    const c2 = node({
      runId: "c2",
      parentRunId: "root",
      startedAt: "2026-01-01T00:00:02.000Z",
    });
    const grandchild = node({ runId: "gc1", parentRunId: "c1", depth: 2 });
    const tree = buildLineageTree([root, c1, c2, grandchild]);

    expect(tree[0]?.children.map((c) => c.node.runId)).toEqual(["c1", "c2"]);
    const c1Node = tree[0]?.children.find((c) => c.node.runId === "c1");
    expect(c1Node?.children.map((c) => c.node.runId)).toEqual(["gc1"]);
    const c2Node = tree[0]?.children.find((c) => c.node.runId === "c2");
    expect(c2Node?.children).toEqual([]);
  });

  it("treats a node whose parentRunId is not in the result set as an orphan root", () => {
    // Simulates re-querying with a childFanoutId as the new dispatchId: the
    // parent run lived in the PREVIOUS query's result set, not this one.
    const orphan = node({
      runId: "orphan",
      parentRunId: "outside-this-batch",
      depth: 0,
    });
    const normalRoot = node({ runId: "root2" });
    const tree = buildLineageTree([orphan, normalRoot]);

    expect(tree).toHaveLength(2);
    const runIds = tree.map((t) => t.node.runId);
    expect(runIds).toContain("orphan");
    expect(runIds).toContain("root2");
    // The orphan itself renders with no fabricated children.
    const orphanEntry = tree.find((t) => t.node.runId === "orphan");
    expect(orphanEntry?.children).toEqual([]);
  });

  it("never loses a node: a self-referencing parentRunId is treated as a root, not dropped", () => {
    const selfRef = node({ runId: "self", parentRunId: "self" });
    const tree = buildLineageTree([selfRef]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.node.runId).toBe("self");
    expect(tree[0]?.children).toEqual([]);
  });

  it("is cycle-safe: a 2-node mutual-parent cycle terminates and drops no node", () => {
    // Malformed/defensive case: A's parent is B and B's parent is A. Neither
    // qualifies as a "true" root (both have a resolvable parent), so both are
    // picked up by the stranded-root safety net. This must terminate (no
    // infinite recursion) and every node must appear exactly once.
    const a = node({ runId: "a", parentRunId: "b" });
    const b = node({ runId: "b", parentRunId: "a" });
    const tree = buildLineageTree([a, b]);

    // Flatten the whole forest and assert each runId appears exactly once.
    const seen: string[] = [];
    function walk(entries: ReturnType<typeof buildLineageTree>) {
      for (const e of entries) {
        seen.push(e.node.runId);
        walk(e.children);
      }
    }
    walk(tree);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("is cycle-safe for a longer cycle (a -> b -> c -> a) with no infinite recursion", () => {
    const a = node({ runId: "a", parentRunId: "c" });
    const b = node({ runId: "b", parentRunId: "a" });
    const c = node({ runId: "c", parentRunId: "b" });
    const tree = buildLineageTree([a, b, c]);

    const seen: string[] = [];
    function walk(entries: ReturnType<typeof buildLineageTree>) {
      for (const e of entries) {
        seen.push(e.node.runId);
        walk(e.children);
      }
    }
    walk(tree);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  it("orders siblings chronologically by startedAt ascending", () => {
    const root = node({ runId: "root" });
    const late = node({
      runId: "late",
      parentRunId: "root",
      startedAt: "2026-01-02T00:00:00.000Z",
    });
    const early = node({
      runId: "early",
      parentRunId: "root",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const mid = node({
      runId: "mid",
      parentRunId: "root",
      startedAt: "2026-01-01T12:00:00.000Z",
    });
    const tree = buildLineageTree([root, late, early, mid]);

    expect(tree[0]?.children.map((c) => c.node.runId)).toEqual([
      "early",
      "mid",
      "late",
    ]);
  });

  it("sorts nodes with a null startedAt last, tie-broken by runId", () => {
    const root = node({ runId: "root" });
    const notStarted2 = node({
      runId: "z-pending",
      parentRunId: "root",
      startedAt: null,
    });
    const notStarted1 = node({
      runId: "a-pending",
      parentRunId: "root",
      startedAt: null,
    });
    const started = node({
      runId: "started",
      parentRunId: "root",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const tree = buildLineageTree([root, notStarted2, notStarted1, started]);

    expect(tree[0]?.children.map((c) => c.node.runId)).toEqual([
      "started",
      "a-pending",
      "z-pending",
    ]);
  });

  it("orders top-level roots chronologically too", () => {
    const late = node({ runId: "late", startedAt: "2026-01-02T00:00:00.000Z" });
    const early = node({
      runId: "early",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const tree = buildLineageTree([late, early]);
    expect(tree.map((t) => t.node.runId)).toEqual(["early", "late"]);
  });

  it("handles a realistic multi-branch, multi-depth fleet tree", () => {
    const root = node({
      runId: "root",
      depth: 0,
      capabilityName: "dispatch_subagent",
    });
    const search1 = node({
      runId: "search1",
      parentRunId: "root",
      depth: 1,
      capabilityName: "search_web",
    });
    const search2 = node({
      runId: "search2",
      parentRunId: "root",
      depth: 1,
      capabilityName: "search_web",
    });
    const nested = node({
      runId: "nested",
      parentRunId: "search1",
      depth: 2,
      capabilityName: "dispatch_subagent",
    });
    const leaf1 = node({
      runId: "leaf1",
      parentRunId: "nested",
      depth: 3,
      capabilityName: "summarize",
    });
    const leaf2 = node({
      runId: "leaf2",
      parentRunId: "nested",
      depth: 3,
      capabilityName: "summarize",
    });

    const tree = buildLineageTree([
      root,
      search1,
      search2,
      nested,
      leaf1,
      leaf2,
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.node.runId).toBe("root");
    expect(tree[0]?.children).toHaveLength(2);
    const s1 = tree[0]?.children.find((c) => c.node.runId === "search1");
    expect(s1?.children).toHaveLength(1);
    expect(s1?.children[0]?.node.runId).toBe("nested");
    expect(s1?.children[0]?.children).toHaveLength(2);
    expect(s1?.children[0]?.children.map((c) => c.node.runId).sort()).toEqual([
      "leaf1",
      "leaf2",
    ]);
  });
});

describe("summarizeLineage", () => {
  it("returns zeroed rollups for an empty list", () => {
    const summary = summarizeLineage([]);
    expect(summary.nodeCount).toBe(0);
    expect(summary.totalSpendUsd).toBe(0);
    expect(summary.violationCount).toBe(0);
    expect(summary.violatingRunIds).toEqual([]);
    expect(summary.maxDepth).toBe(0);
    expect(summary.byOutcome).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  it("sums spend/tokens/calls across nodes", () => {
    const nodes = [
      node({
        runId: "a",
        spend: {
          costUsd: 0.5,
          inputTokens: 100,
          outputTokens: 50,
          llmCalls: 2,
        },
      }),
      node({
        runId: "b",
        spend: {
          costUsd: 1.25,
          inputTokens: 200,
          outputTokens: 75,
          llmCalls: 3,
        },
      }),
    ];
    const summary = summarizeLineage(nodes);
    expect(summary.totalSpendUsd).toBeCloseTo(1.75);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(125);
    expect(summary.totalLlmCalls).toBe(5);
  });

  it("counts outcomes per bucket", () => {
    const nodes = [
      node({ runId: "a", outcome: "completed" }),
      node({ runId: "b", outcome: "completed" }),
      node({ runId: "c", outcome: "failed" }),
      node({ runId: "d", outcome: "cancelled" }),
      node({ runId: "e", outcome: "running" }),
      node({ runId: "f", outcome: "pending" }),
    ];
    const summary = summarizeLineage(nodes);
    expect(summary.byOutcome).toEqual({
      pending: 1,
      running: 1,
      completed: 2,
      failed: 1,
      cancelled: 1,
    });
  });

  it("collects violating runIds and counts them", () => {
    const nodes = [
      node({ runId: "a", delegationViolation: null }),
      node({
        runId: "b",
        delegationViolation: {
          ruleId: "authz_denied",
          message: 'IAM denied "x" for principal: nope',
        },
      }),
      node({
        runId: "c",
        delegationViolation: {
          ruleId: "pending_approval",
          message: "IAM requires approval",
        },
      }),
    ];
    const summary = summarizeLineage(nodes);
    expect(summary.violationCount).toBe(2);
    expect(summary.violatingRunIds.sort()).toEqual(["b", "c"]);
  });

  it("tracks the max depth observed", () => {
    const nodes = [
      node({ runId: "a", depth: 0 }),
      node({ runId: "b", depth: 3 }),
      node({ runId: "c", depth: 1 }),
    ];
    expect(summarizeLineage(nodes).maxDepth).toBe(3);
  });
});
