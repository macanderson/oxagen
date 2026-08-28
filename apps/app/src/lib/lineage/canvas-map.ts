/**
 * lib/lineage/canvas-map.ts — pure LineageNodeDto[] → reagraph node/edge
 * mapping for the fleet-lineage explorer canvas.
 *
 * Kept out of the canvas component (a reagraph/WebGL renderer that cannot be
 * unit-tested in jsdom — see lineage-canvas-view.test.tsx) so every visual
 * encoding rule — outcome colour, the delegation-violation flag, spend-driven
 * sizing, and parent→child edge wiring — is directly unit-tested without
 * rendering anything. `LineageCanvasView` is a thin renderer of this
 * function's output.
 */
import type { LineageNodeDto } from "@oxagen/oxagen/contracts/lineage.query";
import { truncate } from "@/lib/utils";

/** Synthetic node representing the root fan-out (`dispatchId`) itself, so the
 *  canvas always anchors a real tree instead of a set of disconnected roots. */
export const LINEAGE_ROOT_NODE_ID = "__lineage_root__";

// Deterministic per-outcome colour, matching the semantic status palette used
// elsewhere in the app (info/success/warning/error). A delegation-ceiling
// violation OVERRIDES the outcome colour with a distinct amber — "unmistakable"
// per the issue's acceptance criteria, and visually distinct from a plain
// `failed` node (red) so a violation never reads as an ordinary failure.
const OUTCOME_COLOR: Record<LineageNodeDto["outcome"], string> = {
  pending: "#94a3b8", // muted slate
  running: "#0ea5e9", // info sky
  completed: "#10b981", // success emerald
  failed: "#ef4444", // error red
  cancelled: "#a855f7", // violet
};
const VIOLATION_COLOR = "#f97316"; // amber — distinct from OUTCOME_COLOR.failed
const ROOT_COLOR = "#64748b"; // neutral slate, distinguishes the synthetic root

const MIN_SIZE = 6;
const MAX_SIZE = 24;
const VIOLATION_SIZE_BUMP = 4;
const ROOT_SIZE = 10;

export function colorForLineageNode(
  outcome: LineageNodeDto["outcome"],
  violation: boolean,
): string {
  return violation ? VIOLATION_COLOR : OUTCOME_COLOR[outcome];
}

/** Node size grows with observed spend (bigger runs draw the eye), capped so
 *  no single node swamps the canvas; a violation adds a flat size bump on top
 *  so it stands out even when its own spend was small. */
export function sizeForLineageNode(node: LineageNodeDto): number {
  const spendComponent = Math.sqrt(Math.max(node.spend.costUsd, 0)) * 6;
  const bump = node.delegationViolation ? VIOLATION_SIZE_BUMP : 0;
  return Math.min(MIN_SIZE + spendComponent + bump, MAX_SIZE);
}

export interface LineageCanvasNode {
  id: string;
  label: string;
  subLabel: string;
  fill: string;
  size: number;
  data: {
    runId: string;
    outcome: LineageNodeDto["outcome"] | "root";
    violation: boolean;
  };
}

export interface LineageCanvasEdge {
  id: string;
  source: string;
  target: string;
  dashed: boolean;
}

export interface LineageCanvasGraph {
  nodes: LineageCanvasNode[];
  edges: LineageCanvasEdge[];
}

/**
 * Map the flat `query_lineage` adjacency list to reagraph-shaped nodes/edges,
 * anchored under a synthetic root node for the dispatch itself. Never cites a
 * run by its raw id on the label — `label` is the capability name, `subLabel`
 * is the human principal name (⚠-prefixed for a delegation violation); the
 * runId only lives in `data.runId` for the caller's own selection wiring.
 */
export function mapLineageToCanvas(
  nodes: readonly LineageNodeDto[],
  dispatchId: string,
): LineageCanvasGraph {
  const nodeIds = new Set(nodes.map((n) => n.runId));

  const rootNode: LineageCanvasNode = {
    id: LINEAGE_ROOT_NODE_ID,
    label: "Dispatch",
    subLabel: truncate(dispatchId, 20),
    fill: ROOT_COLOR,
    size: ROOT_SIZE,
    data: { runId: LINEAGE_ROOT_NODE_ID, outcome: "root", violation: false },
  };

  const canvasNodes: LineageCanvasNode[] = nodes.map((n) => {
    const violation = n.delegationViolation !== null;
    const principalLabel = truncate(n.principal.displayName, 28);
    return {
      id: n.runId,
      label: truncate(n.capabilityName, 24),
      subLabel: violation ? `⚠ ${principalLabel}` : principalLabel,
      fill: colorForLineageNode(n.outcome, violation),
      size: sizeForLineageNode(n),
      data: { runId: n.runId, outcome: n.outcome, violation },
    };
  });

  const edges: LineageCanvasEdge[] = nodes.map((n) => {
    const resolvedParent =
      n.parentRunId !== null && nodeIds.has(n.parentRunId)
        ? n.parentRunId
        : LINEAGE_ROOT_NODE_ID;
    return {
      id: `${resolvedParent}->${n.runId}`,
      source: resolvedParent,
      target: n.runId,
      dashed: n.delegationViolation !== null,
    };
  });

  return { nodes: [rootNode, ...canvasNodes], edges };
}
