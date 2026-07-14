// @vitest-environment jsdom
/**
 * graph-mini-canvas.test.tsx — render tests for GraphMiniCanvas (default export).
 *
 * reagraph renders a WebGL canvas that cannot work in jsdom, so the whole
 * module is mocked (same pattern as graph-canvas-view.test.tsx). The mock
 * captures the props GraphMiniCanvas passes to GraphCanvas so we can assert
 * the MiniNode/MiniEdge → GraphNode/GraphEdge mapping and the theme toggle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { MiniEdge, MiniNode } from "./graph-mini-canvas";

afterEach(cleanup);

interface StoredProps {
  nodes: Array<{ id: string; label: string; fill: string; size: number }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    fill: string;
    dashed: boolean;
  }>;
  theme: unknown;
  layoutType: string;
  draggable: boolean;
  animated: boolean;
}

let storedProps: StoredProps | null = null;

vi.mock("reagraph", () => ({
  GraphCanvas: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) => {
      storedProps = props;
      return null;
    },
    { displayName: "GraphCanvas" },
  ),
  darkTheme: { name: "dark" },
  lightTheme: { name: "light" },
}));

beforeEach(() => {
  storedProps = null;
});

// Import AFTER mock so the mock is already in place.
import GraphMiniCanvas from "./graph-mini-canvas";

const nodes: MiniNode[] = [
  { id: "n1", label: "Node One", group: "Feature", size: 8 },
  { id: "n2", label: "Node Two", group: "Issue", size: 6 },
  { id: "n3", label: "Node Three", group: "Feature", size: 10 },
];

const edges: MiniEdge[] = [
  { id: "e1", source: "n1", target: "n2", inferred: false },
  { id: "e2", source: "n2", target: "n3", inferred: true },
];

describe("GraphMiniCanvas", () => {
  it("maps MiniNode[] to reagraph GraphNode[] and passes the correct count", () => {
    render(<GraphMiniCanvas nodes={nodes} edges={edges} isDark={false} />);

    expect(storedProps?.nodes).toHaveLength(3);
    expect(storedProps?.nodes[0]).toMatchObject({
      id: "n1",
      label: "Node One",
    });
    expect(typeof storedProps?.nodes[0]?.fill).toBe("string");
    expect(storedProps?.nodes[0]?.size).toBe(8);
  });

  it("maps MiniEdge[] to reagraph GraphEdge[] and passes the correct count", () => {
    render(<GraphMiniCanvas nodes={nodes} edges={edges} isDark={false} />);

    expect(storedProps?.edges).toHaveLength(2);
    const inferred = storedProps?.edges.find((e) => e.id === "e2");
    const confirmed = storedProps?.edges.find((e) => e.id === "e1");
    expect(inferred?.dashed).toBe(true);
    expect(confirmed?.dashed).toBe(false);
    expect(inferred?.source).toBe("n2");
    expect(inferred?.target).toBe("n3");
  });

  it("uses darkTheme when isDark is true", () => {
    render(<GraphMiniCanvas nodes={nodes} edges={edges} isDark={true} />);
    expect(storedProps?.theme).toEqual({ name: "dark" });
  });

  it("uses lightTheme when isDark is false", () => {
    render(<GraphMiniCanvas nodes={nodes} edges={edges} isDark={false} />);
    expect(storedProps?.theme).toEqual({ name: "light" });
  });

  it("renders with an empty graph without error", () => {
    render(<GraphMiniCanvas nodes={[]} edges={[]} isDark={false} />);
    expect(storedProps?.nodes).toHaveLength(0);
    expect(storedProps?.edges).toHaveLength(0);
  });
});
