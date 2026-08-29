/**
 * lib/lineage/tree.ts — pure helpers over `query_lineage`'s flat adjacency
 * list, for the fleet-lineage explorer.
 *
 * The contract (`packages/oxagen/src/contracts/lineage.query.ts`) returns
 * `nodes: LineageNode[]` as a FLAT list — reconstruct the tree client-side by
 * grouping on `parentRunId`. This module does exactly that, plus a small
 * summary rollup for the banner UI. No React, no I/O — every shape here is
 * unit-testable without a DB or a rendered component.
 */
import type { LineageNodeDto } from "@oxagen/oxagen/contracts/lineage.query";

export interface LineageTreeNode {
  node: LineageNodeDto;
  children: LineageTreeNode[];
}

/**
 * Sort key for siblings: chronological by `startedAt` (nodes that never
 * started sort last — they haven't run yet), tie-broken by `runId` so the
 * order is fully deterministic across re-renders.
 */
function compareByStart(a: LineageNodeDto, b: LineageNodeDto): number {
  const aTime = a.startedAt
    ? Date.parse(a.startedAt)
    : Number.POSITIVE_INFINITY;
  const bTime = b.startedAt
    ? Date.parse(b.startedAt)
    : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return a.runId.localeCompare(b.runId);
}

/**
 * Reconstruct the dispatch tree from `query_lineage`'s flat adjacency list.
 *
 * A node is a ROOT when its `parentRunId` is null (a genuine depth-0 node) OR
 * points at a `runId` that is not present in `nodes` (an "orphan" — malformed
 * data, or a node whose parent fell outside a `maxNodes` truncation window).
 * Orphans are surfaced as extra roots rather than silently dropped, so no
 * node ever disappears from the rendered tree.
 *
 * Cycle-safe: `parentRunId` should never form a cycle (each row is one DB
 * run with exactly one parent), but this walks defensively — a node already
 * on the current path is never re-descended into, so malformed/cyclic input
 * can never cause infinite recursion. A node caught in a cycle still renders
 * exactly once, attached wherever the walk first reaches it.
 */
export function buildLineageTree(
  nodes: readonly LineageNodeDto[],
): LineageTreeNode[] {
  const byRunId = new Map(nodes.map((n) => [n.runId, n] as const));
  const childrenByParent = new Map<string, LineageNodeDto[]>();
  const hasResolvableParent = new Set<string>();

  for (const n of nodes) {
    const parentId = n.parentRunId;
    if (parentId !== null && parentId !== n.runId && byRunId.has(parentId)) {
      hasResolvableParent.add(n.runId);
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(n);
      childrenByParent.set(parentId, siblings);
    }
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareByStart);
  }

  const visited = new Set<string>();
  function build(node: LineageNodeDto): LineageTreeNode {
    visited.add(node.runId);
    const kids = childrenByParent.get(node.runId) ?? [];
    return {
      node,
      // Cycle guard: never re-descend into a run already reached on this walk.
      children: kids.filter((k) => !visited.has(k.runId)).map(build),
    };
  }

  const trueRoots = nodes
    .filter((n) => !hasResolvableParent.has(n.runId))
    .sort(compareByStart)
    .map(build);

  // Safety net: nodes never reached above (only possible via a parentRunId
  // cycle entirely among non-root nodes) still render — as extra roots —
  // rather than vanishing. Re-check `visited` per candidate: building an
  // earlier stranded root can already reach a later one via the cycle.
  const strandedRoots: LineageTreeNode[] = [];
  for (const n of nodes.slice().sort(compareByStart)) {
    if (!visited.has(n.runId)) strandedRoots.push(build(n));
  }

  return [...trueRoots, ...strandedRoots];
}

export interface LineageSummary {
  nodeCount: number;
  totalSpendUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLlmCalls: number;
  violationCount: number;
  violatingRunIds: string[];
  byOutcome: Record<LineageNodeDto["outcome"], number>;
  maxDepth: number;
}

/** Roll up spend, violations, and outcome counts across the flat node list. */
export function summarizeLineage(
  nodes: readonly LineageNodeDto[],
): LineageSummary {
  const byOutcome: LineageSummary["byOutcome"] = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  let totalSpendUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLlmCalls = 0;
  let maxDepth = 0;
  const violatingRunIds: string[] = [];

  for (const n of nodes) {
    byOutcome[n.outcome] += 1;
    totalSpendUsd += n.spend.costUsd;
    totalInputTokens += n.spend.inputTokens;
    totalOutputTokens += n.spend.outputTokens;
    totalLlmCalls += n.spend.llmCalls;
    if (n.depth > maxDepth) maxDepth = n.depth;
    if (n.delegationViolation) violatingRunIds.push(n.runId);
  }

  return {
    nodeCount: nodes.length,
    totalSpendUsd,
    totalInputTokens,
    totalOutputTokens,
    totalLlmCalls,
    violationCount: violatingRunIds.length,
    violatingRunIds,
    byOutcome,
    maxDepth,
  };
}
