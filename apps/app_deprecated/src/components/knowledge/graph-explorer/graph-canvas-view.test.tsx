// @vitest-environment jsdom
/**
 * graph-canvas-view.test.tsx — render tests for GraphCanvasView (default export).
 *
 * reagraph renders a WebGL canvas that cannot work in jsdom, so the whole
 * module is mocked. The mock captures the props that the component passes to
 * GraphCanvas so we can assert the ExplorerNode/ExplorerEdge → GraphNode/GraphEdge
 * mapping. The `onApiReady` path is exercised separately via the `setRef`
 * callback — since the mock component cannot forward refs the way reagraph does,
 * we expose the ref callback through a side-channel and call it manually.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ExplorerEdge, ExplorerNode } from "./types";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Side-channel: the mock stores the latest props and the ref callback so that
// tests can simulate the GraphCanvasRef being mounted/unmounted.
// ---------------------------------------------------------------------------
interface StoredProps {
  nodes: unknown[];
  edges: unknown[];
  onNodeClick: ((node: { id: string }) => void) | undefined;
  onEdgeClick: ((edge: { id: string }) => void) | undefined;
  onCanvasClick: (() => void) | undefined;
  draggable: boolean;
  layoutType: string;
}

let storedProps: StoredProps | null = null;
let storedRefCallback: ((instance: unknown) => void) | null = null;

vi.mock("reagraph", () => ({
  // A forwardRef-like mock: receive all props AND the ref argument.
  // Vitest hoists vi.mock so this runs before any import of graph-canvas-view.
  GraphCanvas: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any, ref: any) => {
      storedProps = props;
      // The component passes a callback ref (`setRef`) as the `ref` prop in JSX.
      // React passes callback refs as the second argument to forwardRef, but our
      // simple function component receives it here as a prop named `ref` in the
      // JSX spread (React 19 passes ref as a regular prop when using `ref=` on a
      // non-forwardRef component, but in React 18 it does NOT forward it).
      // We cover both cases: store from explicit `ref` arg AND from `props.ref`.
      const refCb =
        typeof ref === "function"
          ? ref
          : typeof props.ref === "function"
            ? props.ref
            : null;
      storedRefCallback = refCb;
      return null;
    },
    { displayName: "GraphCanvas" },
  ),
  darkTheme: { colors: {} },
  lightTheme: { colors: {} },
}));

beforeEach(() => {
  storedProps = null;
  storedRefCallback = null;
});

// Import AFTER mock so the mock is already in place.
import GraphCanvasView from "./graph-canvas-view";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseNode: ExplorerNode = {
  id: "node-1",
  label: "Issue",
  displayName: "My Issue",
  degree: 2,
  hydrated: true,
};

const inferredEdge: ExplorerEdge = {
  id: "node-1->node-2:REL",
  source: "node-1",
  target: "node-2",
  type: "REL",
  inferred: true,
  confidence: 0.9,
};

const confirmedEdge: ExplorerEdge = {
  id: "node-1->node-3:KNOWS",
  source: "node-1",
  target: "node-3",
  type: "KNOWS",
  inferred: false,
};

const defaultProps = {
  nodes: [baseNode],
  edges: [inferredEdge, confirmedEdge],
  selectedId: null,
  actives: [] as string[],
  view: "2d" as const,
  draggable: false,
  animated: true,
  isDark: false,
  onSelectNode: vi.fn(),
  onSelectEdge: vi.fn(),
  onClearSelection: vi.fn(),
  onExpandNode: vi.fn(),
  onEdgeHover: vi.fn(),
  onApiReady: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphCanvasView — node mapping", () => {
  it("maps ExplorerNode id to GraphNode id", () => {
    render(<GraphCanvasView {...defaultProps} />);
    const graphNodes = storedProps?.nodes as Array<{ id: string }>;
    expect(graphNodes[0]?.id).toBe("node-1");
  });

  it("maps ExplorerNode displayName (possibly truncated) to GraphNode label", () => {
    render(<GraphCanvasView {...defaultProps} />);
    const graphNodes = storedProps?.nodes as Array<{ label: string }>;
    // truncate("My Issue", 24) === "My Issue" (short enough)
    expect(graphNodes[0]?.label).toBe("My Issue");
  });

  it("maps ExplorerNode label to a non-empty fill colour string", () => {
    render(<GraphCanvasView {...defaultProps} />);
    const graphNodes = storedProps?.nodes as Array<{ fill: string }>;
    expect(typeof graphNodes[0]?.fill).toBe("string");
    expect(graphNodes[0]?.fill.length).toBeGreaterThan(0);
  });

  it("maps ExplorerNode degree to a positive numeric size", () => {
    render(<GraphCanvasView {...defaultProps} />);
    const graphNodes = storedProps?.nodes as Array<{ size: number }>;
    expect(typeof graphNodes[0]?.size).toBe("number");
    expect(graphNodes[0]?.size).toBeGreaterThan(0);
  });

  it("higher degree produces a larger size (capped at 22)", () => {
    const bigNode = { ...baseNode, degree: 20 };
    render(<GraphCanvasView {...defaultProps} nodes={[bigNode]} />);
    const graphNodes = storedProps?.nodes as Array<{ size: number }>;
    expect(graphNodes[0]?.size).toBeLessThanOrEqual(22);
    expect(graphNodes[0]?.size).toBeGreaterThan(6);
  });
});

describe("GraphCanvasView — edge mapping", () => {
  it("maps ExplorerEdge id, source, and target", () => {
    render(<GraphCanvasView {...defaultProps} />);
    const graphEdges = storedProps?.edges as Array<{
      id: string;
      source: string;
      target: string;
    }>;
    const inferred = graphEdges.find((e) => e.id === "node-1->node-2:REL");
    expect(inferred).toBeDefined();
    expect(inferred?.source).toBe("node-1");
    expect(inferred?.target).toBe("node-2");
  });

  it("marks inferred edges as dashed=true", () => {
    render(<GraphCanvasView {...defaultProps} />);
    const graphEdges = storedProps?.edges as Array<{
      id: string;
      dashed: boolean;
    }>;
    const inferred = graphEdges.find((e) => e.id === "node-1->node-2:REL");
    expect(inferred?.dashed).toBe(true);
  });

  it("marks confirmed edges as dashed=false", () => {
    render(<GraphCanvasView {...defaultProps} />);
    const graphEdges = storedProps?.edges as Array<{
      id: string;
      dashed: boolean;
    }>;
    const confirmed = graphEdges.find((e) => e.id === "node-1->node-3:KNOWS");
    expect(confirmed?.dashed).toBe(false);
  });

  it("assigns different fill colours to inferred vs confirmed edges", () => {
    render(<GraphCanvasView {...defaultProps} />);
    const graphEdges = storedProps?.edges as Array<{
      id: string;
      fill: string;
    }>;
    const inferred = graphEdges.find((e) => e.id === "node-1->node-2:REL");
    const confirmed = graphEdges.find((e) => e.id === "node-1->node-3:KNOWS");
    expect(inferred?.fill).not.toBe(confirmed?.fill);
  });
});

describe("GraphCanvasView — layout type", () => {
  it("uses forceDirected2d for view='2d'", () => {
    render(<GraphCanvasView {...defaultProps} view="2d" />);
    expect(storedProps?.layoutType).toBe("forceDirected2d");
  });

  it("uses forceDirected3d for view='3d'", () => {
    render(<GraphCanvasView {...defaultProps} view="3d" />);
    expect(storedProps?.layoutType).toBe("forceDirected3d");
  });
});

describe("GraphCanvasView — draggable prop", () => {
  it("passes draggable=true through to GraphCanvas", () => {
    render(<GraphCanvasView {...defaultProps} draggable={true} />);
    expect(storedProps?.draggable).toBe(true);
  });

  it("passes draggable=false through to GraphCanvas", () => {
    render(<GraphCanvasView {...defaultProps} draggable={false} />);
    expect(storedProps?.draggable).toBe(false);
  });
});

describe("GraphCanvasView — onApiReady via ref callback", () => {
  it("calls onApiReady with an api object when the ref callback fires with an instance", () => {
    const onApiReady = vi.fn();
    render(<GraphCanvasView {...defaultProps} onApiReady={onApiReady} />);

    const fakeRef = {
      exportCanvas: vi.fn(() => "data:image/png;base64,abc"),
      fitNodesInView: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      resetControls: vi.fn(),
    };

    // Simulate the canvas mounting: invoke the callback ref that the component
    // registered as `ref={setRef}` on <GraphCanvas>.
    act(() => {
      storedRefCallback?.(fakeRef);
    });

    expect(onApiReady).toHaveBeenCalledWith(
      expect.objectContaining({
        exportImage: expect.any(Function),
        fit: expect.any(Function),
        zoomIn: expect.any(Function),
        zoomOut: expect.any(Function),
        reset: expect.any(Function),
      }),
    );
  });

  it("exportImage() delegates to ref.exportCanvas()", () => {
    const onApiReady = vi.fn();
    render(<GraphCanvasView {...defaultProps} onApiReady={onApiReady} />);

    const fakeRef = {
      exportCanvas: vi.fn(() => "data:image/png;base64,xyz"),
      fitNodesInView: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      resetControls: vi.fn(),
    };

    act(() => {
      storedRefCallback?.(fakeRef);
    });

    const api = onApiReady.mock.calls[0]?.[0];
    const result = api?.exportImage();
    expect(result).toBe("data:image/png;base64,xyz");
    expect(fakeRef.exportCanvas).toHaveBeenCalled();
  });

  it("calls onApiReady(null) when the ref callback is called with null (unmount)", () => {
    const onApiReady = vi.fn();
    render(<GraphCanvasView {...defaultProps} onApiReady={onApiReady} />);

    act(() => {
      // First mount
      storedRefCallback?.({
        exportCanvas: vi.fn(),
        fitNodesInView: vi.fn(),
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        resetControls: vi.fn(),
      });
      // Then unmount
      storedRefCallback?.(null);
    });

    expect(onApiReady).toHaveBeenLastCalledWith(null);
  });
});
