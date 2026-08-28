/**
 * graph-mini-canvas.tsx — the tiny WebGL knowledge-graph preview (reagraph).
 *
 * The ONLY overview module that imports reagraph; loaded exclusively via
 * `next/dynamic({ ssr: false })` from graph-mini-viz.tsx so the Three.js/WebGL
 * bundle never ships in SSR or the initial payload. Deliberately minimal — no
 * toolbar, selection, hover, or drag; it is a "grounding is alive" glance, not
 * the full explorer (that lives at knowledge/graph). Node colour encodes the
 * domain label; dashed gold edges are LLM-inferred. Colours are shared with
 * the explorer so the preview and the full canvas never drift.
 */
"use client";

import {
  GraphCanvas,
  darkTheme,
  lightTheme,
  type GraphNode,
  type GraphEdge,
} from "reagraph";
import {
  colorForEdge,
  colorForLabel,
} from "@/components/knowledge/graph-explorer/lib/colors";

export interface MiniNode {
  id: string;
  label: string;
  /** Domain label that drives the node colour. */
  group: string;
  size: number;
}

export interface MiniEdge {
  id: string;
  source: string;
  target: string;
  inferred: boolean;
}

export default function GraphMiniCanvas({
  nodes,
  edges,
  isDark,
}: {
  nodes: MiniNode[];
  edges: MiniEdge[];
  isDark: boolean;
}) {
  const graphNodes: GraphNode[] = nodes.map((n) => ({
    id: n.id,
    label: n.label,
    fill: colorForLabel(n.group),
    size: n.size,
  }));

  const graphEdges: GraphEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    fill: colorForEdge(e.inferred),
    dashed: e.inferred,
  }));

  return (
    <GraphCanvas
      nodes={graphNodes}
      edges={graphEdges}
      layoutType="forceDirected2d"
      cameraMode="pan"
      labelType="none"
      edgeArrowPosition="none"
      draggable={false}
      animated={false}
      theme={isDark ? darkTheme : lightTheme}
    />
  );
}
