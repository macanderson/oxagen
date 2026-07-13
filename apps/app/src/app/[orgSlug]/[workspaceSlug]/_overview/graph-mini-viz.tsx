/**
 * graph-mini-viz.tsx — client boundary for the knowledge-graph preview.
 *
 * Dynamically imports the reagraph canvas with `ssr: false` (WebGL can't run on
 * the server and the bundle is heavy) and tracks the app's dark/light theme so
 * the canvas theme matches. Receives an already-sampled, serialisable subgraph
 * from the server hero — it never fetches. The wrapper owns the fixed-height,
 * clipped surface the canvas fills.
 */
"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { MiniEdge, MiniNode } from "./graph-mini-canvas";

const GraphMiniCanvas = dynamic(() => import("./graph-mini-canvas"), {
  ssr: false,
  loading: () => (
    <div
      className="h-full w-full animate-pulse rounded-xl bg-muted"
      aria-hidden="true"
    />
  ),
});

/** Track the app's active theme (.dark / .light class, else system pref). */
function useDarkMode(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const compute = () => {
      if (root.classList.contains("dark")) return true;
      if (root.classList.contains("light")) return false;
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    };
    setDark(compute());
    const obs = new MutationObserver(() => setDark(compute()));
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export function GraphMiniViz({
  nodes,
  edges,
}: {
  nodes: MiniNode[];
  edges: MiniEdge[];
}) {
  const isDark = useDarkMode();
  return (
    <div
      className="relative h-56 w-full overflow-hidden rounded-xl border border-border bg-card sm:h-64"
      data-testid="overview-graph-mini-viz"
    >
      <GraphMiniCanvas nodes={nodes} edges={edges} isDark={isDark} />
    </div>
  );
}
