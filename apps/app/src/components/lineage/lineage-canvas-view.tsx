/**
 * lineage-canvas-view.tsx — the WebGL fleet-lineage renderer (reagraph).
 *
 * A lineage-specific canvas, NOT a reuse of
 * `@/components/knowledge/graph-explorer/graph-canvas-view.tsx`: that
 * component colours nodes by a hashed domain label (`colorForLabel`), which
 * cannot express "this node violated its delegation ceiling — unmistakably".
 * This canvas colours/sizes nodes by outcome + violation via the pure
 * `mapLineageToCanvas` (lib/lineage/canvas-map.ts) instead, but otherwise
 * follows GraphCanvasView's exact discipline: it is the ONLY module that
 * imports reagraph, loaded exclusively via `next/dynamic({ ssr: false })`
 * from the orchestrator (`lineage-explorer.tsx`) so the WebGL bundle never
 * ships in SSR, and it exposes an imperative fit/zoom/reset/export API via
 * `onApiReady` since `next/dynamic` does not forward refs.
 */

"use client";

import * as React from "react";
import {
  GraphCanvas,
  darkTheme,
  lightTheme,
  type GraphCanvasRef,
  type InternalGraphNode,
} from "reagraph";
import type { LineageNodeDto } from "@oxagen/oxagen/contracts/lineage.query";
import {
  mapLineageToCanvas,
  LINEAGE_ROOT_NODE_ID,
} from "@/lib/lineage/canvas-map";

/** Imperative handle surfaced to the toolbar (fit / zoom / reset). Mirrors
 *  GraphCanvasApi's shape so both canvases stay callable identically. */
export interface LineageCanvasApi {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

export interface LineageCanvasViewProps {
  nodes: LineageNodeDto[];
  dispatchId: string;
  selectedRunId: string | null;
  isDark: boolean;
  onSelectRun: (runId: string) => void;
  onClearSelection: () => void;
  onApiReady: (api: LineageCanvasApi | null) => void;
}

export default function LineageCanvasView({
  nodes,
  dispatchId,
  selectedRunId,
  isDark,
  onSelectRun,
  onClearSelection,
  onApiReady,
}: LineageCanvasViewProps) {
  const ref = React.useRef<GraphCanvasRef | null>(null);

  const graph = React.useMemo(
    () => mapLineageToCanvas(nodes, dispatchId),
    [nodes, dispatchId],
  );

  const selections = React.useMemo(
    () => (selectedRunId ? [selectedRunId] : []),
    [selectedRunId],
  );

  // Publish the imperative API once the canvas ref is attached; tear it down
  // on unmount so a stale handle never fires (mirrors GraphCanvasView).
  const setRef = React.useCallback(
    (instance: GraphCanvasRef | null) => {
      ref.current = instance;
      if (instance) {
        onApiReady({
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
    <div className="relative h-full w-full">
      <GraphCanvas
        ref={setRef}
        nodes={graph.nodes}
        edges={graph.edges}
        selections={selections}
        draggable={false}
        layoutType="treeTd2d"
        cameraMode="pan"
        labelType="all"
        edgeArrowPosition="end"
        theme={isDark ? darkTheme : lightTheme}
        animated
        onNodeClick={(node: InternalGraphNode) => {
          if (node.id === LINEAGE_ROOT_NODE_ID) return;
          onSelectRun(node.id);
        }}
        onCanvasClick={() => onClearSelection()}
      />
    </div>
  );
}
