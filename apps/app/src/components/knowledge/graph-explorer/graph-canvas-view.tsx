/**
 * graph-canvas-view.tsx — the WebGL graph renderer (reagraph).
 *
 * This is the ONLY module that imports reagraph, and it is loaded exclusively
 * via `next/dynamic({ ssr: false })` from the orchestrator so the heavy
 * Three.js/WebGL bundle never ships in SSR or the initial client payload — the
 * page paints its chrome first, then hydrates the canvas. It maps the explorer's
 * plain node/edge shapes to reagraph's, wires selection/hover/drag callbacks back
 * up, and exposes an imperative API (export image, fit, zoom, reset) via
 * `onApiReady` since `next/dynamic` does not forward refs.
 */

"use client";

import * as React from "react";
import {
  GraphCanvas,
  darkTheme,
  lightTheme,
  type GraphCanvasRef,
  type GraphNode,
  type GraphEdge,
  type InternalGraphNode,
  type InternalGraphEdge,
} from "reagraph";
import type { ExplorerEdge, ExplorerNode } from "./types";
import { colorForEdge, colorForLabel } from "./lib/colors";
import { truncate } from "./lib/format";

/** Imperative handle surfaced to the toolbar (export / fit / zoom / reset). */
export interface GraphCanvasApi {
  exportImage: () => string | undefined;
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

export interface GraphCanvasViewProps {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  selectedId: string | null;
  /** Highlighted ids; everything else is dimmed when this is non-empty. */
  actives: string[];
  view: "2d" | "3d";
  draggable: boolean;
  animated: boolean;
  isDark: boolean;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClearSelection: () => void;
  onExpandNode: (id: string) => void;
  onEdgeHover: (
    edge: ExplorerEdge | null,
    pos: { x: number; y: number } | null,
  ) => void;
  onApiReady: (api: GraphCanvasApi | null) => void;
}

function nodeSize(degree: number): number {
  // Emphasise "super nodes": size grows with connectivity, capped so a hub
  // never swamps the canvas.
  return Math.min(6 + degree * 1.4, 22);
}

export default function GraphCanvasView({
  nodes,
  edges,
  selectedId,
  actives,
  view,
  draggable,
  animated,
  isDark,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onExpandNode,
  onEdgeHover,
  onApiReady,
}: GraphCanvasViewProps) {
  const ref = React.useRef<GraphCanvasRef | null>(null);
  const cursor = React.useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const edgeById = React.useMemo(
    () => new Map(edges.map((e) => [e.id, e])),
    [edges],
  );

  const graphNodes: GraphNode[] = React.useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        label: truncate(n.displayName, 24),
        fill: colorForLabel(n.label),
        size: nodeSize(n.degree),
        data: { label: n.label },
      })),
    [nodes],
  );

  const graphEdges: GraphEdge[] = React.useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.type,
        fill: colorForEdge(e.inferred),
        dashed: e.inferred,
      })),
    [edges],
  );

  const selections = React.useMemo(
    () => (selectedId ? [selectedId] : []),
    [selectedId],
  );

  // Publish the imperative API once the canvas ref is attached; tear it down on
  // unmount (e.g. switching to the table view) so stale handles never fire.
  const setRef = React.useCallback(
    (instance: GraphCanvasRef | null) => {
      ref.current = instance;
      if (instance) {
        onApiReady({
          exportImage: () => ref.current?.exportCanvas(),
          fit: () => ref.current?.fitNodesInView(),
          zoomIn: () => ref.current?.zoomIn(),
          zoomOut: () => ref.current?.zoomOut(),
          reset: () => ref.current?.resetControls(true),
        });
      } else {
        onApiReady(null);
      }
    },
    [onApiReady],
  );

  return (
    <div
      className="relative h-full w-full"
      onPointerMove={(e) => {
        cursor.current = { x: e.clientX, y: e.clientY };
      }}
    >
      <GraphCanvas
        ref={setRef}
        nodes={graphNodes}
        edges={graphEdges}
        selections={selections}
        actives={actives}
        draggable={draggable}
        layoutType={view === "3d" ? "forceDirected3d" : "forceDirected2d"}
        cameraMode={view === "3d" ? "orbit" : "pan"}
        labelType="auto"
        edgeArrowPosition="end"
        theme={isDark ? darkTheme : lightTheme}
        animated={animated}
        onNodeClick={(node: InternalGraphNode) => onSelectNode(node.id)}
        onNodeDoubleClick={(node: InternalGraphNode) => onExpandNode(node.id)}
        onEdgeClick={(edge: InternalGraphEdge) => onSelectEdge(edge.id)}
        onCanvasClick={() => onClearSelection()}
        onEdgePointerOver={(edge: InternalGraphEdge) => {
          const explorerEdge = edgeById.get(edge.id);
          if (explorerEdge) onEdgeHover(explorerEdge, cursor.current);
        }}
        onEdgePointerOut={() => onEdgeHover(null, null)}
      />
    </div>
  );
}
