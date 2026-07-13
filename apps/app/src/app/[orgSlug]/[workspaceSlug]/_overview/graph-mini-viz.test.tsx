// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { MiniEdge, MiniNode } from "./graph-mini-canvas";

// jsdom does not implement window.matchMedia. GraphMiniViz's useDarkMode falls
// back to it when the <html> element has neither a "dark" nor "light" class
// (the default in this test's clean jsdom document), so a stub is required
// for the component to mount at all. Mirrors use-media-query.test.ts.
function stubMatchMedia(matches = false) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// next/dynamic normally lazy-loads the reagraph canvas client-side; stub it to
// synchronously return a plain component so the test never touches reagraph
// or Next's dynamic-import machinery. Mirrors execution-lineage-canvas.test.tsx.
vi.mock("next/dynamic", () => ({
  default: () =>
    function GraphMiniCanvasStub(props: {
      nodes: MiniNode[];
      edges: MiniEdge[];
      isDark: boolean;
    }) {
      return (
        <div
          data-testid="stub-graph-mini-canvas"
          data-node-count={props.nodes.length}
          data-edge-count={props.edges.length}
          data-is-dark={String(props.isDark)}
        />
      );
    },
}));

import { GraphMiniViz } from "./graph-mini-viz";

beforeEach(() => {
  stubMatchMedia(false);
  document.documentElement.classList.remove("dark", "light");
});

afterEach(cleanup);

const nodes: MiniNode[] = [
  { id: "n1", label: "Node One", group: "Feature", size: 8 },
  { id: "n2", label: "Node Two", group: "Issue", size: 6 },
];

const edges: MiniEdge[] = [
  { id: "e1", source: "n1", target: "n2", inferred: false },
];

describe("GraphMiniViz", () => {
  it("renders the wrapper testid", () => {
    render(<GraphMiniViz nodes={nodes} edges={edges} />);
    expect(screen.getByTestId("overview-graph-mini-viz")).toBeInTheDocument();
  });

  it("passes nodes and edges through to the (stubbed) canvas", () => {
    render(<GraphMiniViz nodes={nodes} edges={edges} />);

    const canvas = screen.getByTestId("stub-graph-mini-canvas");
    expect(canvas).toHaveAttribute("data-node-count", "2");
    expect(canvas).toHaveAttribute("data-edge-count", "1");
  });

  it("renders with an empty graph without error", () => {
    render(<GraphMiniViz nodes={[]} edges={[]} />);

    const canvas = screen.getByTestId("stub-graph-mini-canvas");
    expect(canvas).toHaveAttribute("data-node-count", "0");
    expect(canvas).toHaveAttribute("data-edge-count", "0");
  });

  it("passes isDark=true to the canvas when the document has the dark class", () => {
    document.documentElement.classList.add("dark");
    render(<GraphMiniViz nodes={nodes} edges={edges} />);

    const canvas = screen.getByTestId("stub-graph-mini-canvas");
    expect(canvas).toHaveAttribute("data-is-dark", "true");
  });

  it("passes isDark=false to the canvas when the document has the light class", () => {
    document.documentElement.classList.add("light");
    render(<GraphMiniViz nodes={nodes} edges={edges} />);

    const canvas = screen.getByTestId("stub-graph-mini-canvas");
    expect(canvas).toHaveAttribute("data-is-dark", "false");
  });
});
