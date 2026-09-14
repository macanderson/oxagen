// @vitest-environment jsdom
/**
 * graph-explorer.test.tsx — responsive behaviour of the explorer orchestrator.
 *
 * matchMedia is mocked per test to simulate desktop (hover-capable, ≥lg) vs
 * mobile (touch, <lg). Covers: node/edge detail renders in the right-hand
 * aside on desktop but in a bottom sheet on mobile, the filter toggle opens
 * the type-filter sheet on mobile, the "Expand neighbours" action works from
 * the mobile sheet (touch alternative to double-click), the edge hover
 * popover is suppressed on non-hover devices, and mobile canvas defaults
 * (dragging + animation off).
 */

import * as React from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExplorerEdge, ExplorerNode } from "./types";

const {
  NODES,
  EDGES,
  expandMock,
  reloadMock,
  addSubgraphMock,
  canvasProps,
  explorerState,
} = vi.hoisted(() => {
  const NODES = [
    {
      id: "n1",
      label: "Person",
      displayName: "Ada Lovelace",
      degree: 1,
      hydrated: true,
      properties: {},
    },
    {
      id: "n2",
      label: "Company",
      displayName: "Analytical Engines",
      degree: 1,
      hydrated: true,
      properties: {},
    },
  ];
  const EDGES = [
    {
      id: "e1",
      source: "n1",
      target: "n2",
      type: "WORKS_AT",
      inferred: false,
    },
  ];
  return {
    NODES,
    EDGES,
    expandMock: vi.fn(() => Promise.resolve()),
    reloadMock: vi.fn(),
    addSubgraphMock: vi.fn(),
    canvasProps: { current: null as Record<string, unknown> | null },
    // Mutable so a test can drive the empty / filtered-empty branches; reset
    // to the populated defaults in the global beforeEach.
    explorerState: {
      nodes: NODES as unknown[],
      edges: EDGES as unknown[],
      stats: null as unknown,
    },
  };
});

vi.mock("@/lib/tenant/tenant-context", () => ({
  useTenant: () => ({ orgSlug: "acme", workspaceSlug: "main" }),
}));

vi.mock("./use-explorer-data", () => ({
  useExplorerData: () => ({
    nodes: explorerState.nodes,
    edges: explorerState.edges,
    stats: explorerState.stats,
    status: "ready",
    error: null,
    truncated: false,
    expandingId: null,
    reload: reloadMock,
    expand: expandMock,
    addSubgraph: addSubgraphMock,
  }),
}));

// The WebGL canvas is far too heavy for jsdom — capture the props the explorer
// hands it so tests can drive selection/hover callbacks directly.
vi.mock("next/dynamic", () => ({
  default: () =>
    function MockCanvas(props: Record<string, unknown>) {
      canvasProps.current = props;
      return <div data-testid="mock-canvas" />;
    },
}));

vi.mock("./api-client", () => ({
  fetchNodeDetail: vi.fn((_tenant: unknown, nodeId: string) =>
    Promise.resolve({
      node: NODES.find((n) => n.id === nodeId) ?? null,
      neighbors: [],
    }),
  ),
  fetchNodes: vi.fn(() =>
    Promise.resolve({ nodes: [], total: 0, hasMore: false }),
  ),
  searchNodes: vi.fn(() => Promise.resolve({ nodes: [] })),
}));

// Base UI sheet renders through a portal/backdrop stack that jsdom does not
// need — a minimal open-gate keeps the assertions about what the explorer
// mounts where.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    children,
    open,
  }: {
    children?: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetPopup: ({
    children,
    className,
    side: _side,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement> & { side?: string }) => (
    <div data-testid="sheet-popup" className={className} {...rest}>
      {children}
    </div>
  ),
  SheetHeader: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { GraphExplorer } from "./graph-explorer";

type CanvasCallbacks = {
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onEdgeHover: (
    edge: ExplorerEdge | null,
    pos: { x: number; y: number } | null,
  ) => void;
  draggable: boolean;
  animated: boolean;
};

function canvas(): CanvasCallbacks {
  expect(canvasProps.current).not.toBeNull();
  return canvasProps.current as unknown as CanvasCallbacks;
}

function setMatchMedia(matches: (query: string) => boolean) {
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** ≥lg pointer-fine desktop: hover available, no mobile breakpoints match. */
const asDesktop = () => setMatchMedia((q) => q === "(hover: hover)");
/** Phone: both max-width breakpoints match, no hover capability. */
const asMobile = () => setMatchMedia((q) => q.includes("max-width"));

function selectNode(id = "n1") {
  act(() => canvas().onSelectNode(id));
}

beforeEach(() => {
  canvasProps.current = null;
  explorerState.nodes = NODES;
  explorerState.edges = EDGES;
  explorerState.stats = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("GraphExplorer — desktop (≥lg, hover-capable)", () => {
  beforeEach(asDesktop);

  it("renders the node detail in the right-hand aside, not a sheet", async () => {
    render(<GraphExplorer />);
    selectNode();
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    // The detail renders inside a complementary landmark (the filter aside is
    // one too, so scope by content); no sheet is mounted.
    const asides = screen.getAllByRole("complementary");
    expect(
      asides.some((aside) => aside.textContent?.includes("Ada Lovelace")),
    ).toBe(true);
    expect(screen.queryByTestId("sheet")).not.toBeInTheDocument();
  });

  it("shows the edge hover popover on hover-capable devices", () => {
    render(<GraphExplorer />);
    act(() => canvas().onEdgeHover(EDGES[0] as ExplorerEdge, { x: 10, y: 10 }));
    const tooltip = screen.getByRole("tooltip");
    // Scope to the tooltip — the type-filter panel lists "WORKS_AT" too.
    expect(within(tooltip).getByText("WORKS_AT")).toBeInTheDocument();
  });

  it("keeps node dragging enabled by default", () => {
    render(<GraphExplorer />);
    expect(canvas().draggable).toBe(true);
  });

  it("filter toggle collapses the inline filter panel (no sheet)", () => {
    render(<GraphExplorer />);
    // Filters start visible on desktop.
    expect(screen.getByText("Node types")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /hide filters/i }));
    expect(screen.queryByText("Node types")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sheet")).not.toBeInTheDocument();
  });
});

describe("GraphExplorer — mobile (<lg, touch)", () => {
  beforeEach(asMobile);

  it("renders the node detail in a bottom sheet instead of the aside", async () => {
    render(<GraphExplorer />);
    selectNode();
    const sheet = await screen.findByTestId("sheet");
    expect(sheet).toHaveTextContent("Ada Lovelace");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("closing the detail sheet clears the selection", async () => {
    render(<GraphExplorer />);
    selectNode();
    await screen.findByTestId("sheet");
    fireEvent.click(screen.getByRole("button", { name: /close detail/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("sheet")).not.toBeInTheDocument(),
    );
  });

  it("renders the edge detail in the sheet when an edge is selected", async () => {
    render(<GraphExplorer />);
    act(() => canvas().onSelectEdge("e1"));
    const sheet = await screen.findByTestId("sheet");
    expect(sheet).toHaveTextContent("WORKS_AT");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("'Expand neighbours' in the sheet expands the node (touch alternative to double-click)", async () => {
    render(<GraphExplorer />);
    selectNode();
    const expand = await screen.findByRole("button", {
      name: /expand neighbours/i,
    });
    fireEvent.click(expand);
    expect(expandMock).toHaveBeenCalledWith("n1");
  });

  it("filter toggle is visible and opens the filters sheet", async () => {
    render(<GraphExplorer />);
    // No inline filter panel on mobile.
    expect(screen.queryByText("Node types")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show filters/i }));
    const sheet = await screen.findByTestId("sheet");
    expect(sheet).toHaveTextContent("Filters");
    expect(sheet).toHaveTextContent("Node types");
  });

  it("never renders the edge hover popover on touch devices", () => {
    render(<GraphExplorer />);
    act(() => canvas().onEdgeHover(EDGES[0] as ExplorerEdge, { x: 10, y: 10 }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("disables node dragging and animation by default", async () => {
    render(<GraphExplorer />);
    await waitFor(() => {
      expect(canvas().draggable).toBe(false);
      expect(canvas().animated).toBe(false);
    });
  });
});

describe("GraphExplorer — node fixtures", () => {
  it("fixture shapes satisfy the explorer contracts", () => {
    // Compile-time guard: fixtures must remain valid ExplorerNode/ExplorerEdge.
    const nodes: ExplorerNode[] = NODES;
    const edges: ExplorerEdge[] = EDGES;
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
  });
});

describe("GraphExplorer — empty and filtered-empty states", () => {
  beforeEach(asDesktop);

  const statsWith = (nodeCount: number) => ({
    nodeCount,
    edgeCount: 0,
    inferredEdgeCount: 0,
    nodesByLabel: [],
    edgesByType: [],
  });

  it("shows the empty state when the seed is empty, whatever the stats say", () => {
    // The component renders EmptyState on an empty seed unconditionally —
    // there is no "Show agent activity" toggle gating it.
    explorerState.nodes = [];
    explorerState.edges = [];
    explorerState.stats = statsWith(4);
    render(<GraphExplorer />);
    expect(screen.getByText(/no graph data yet/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show agent activity/i }),
    ).toBeNull();
  });

  it("shows the true empty state when the whole graph is empty", () => {
    explorerState.nodes = [];
    explorerState.edges = [];
    explorerState.stats = statsWith(0);
    render(<GraphExplorer />);
    expect(screen.getByText(/no graph data yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/hidden by filters/i)).toBeNull();
  });

  it("offers to clear filters when every node type is hidden", () => {
    render(<GraphExplorer />);
    expect(screen.getByTestId("mock-canvas")).toBeInTheDocument();
    // Hide every node type via the filter panel's "None" control.
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.queryByTestId("mock-canvas")).not.toBeInTheDocument();
    expect(screen.getByText(/2 nodes hidden by filters/i)).toBeInTheDocument();
    // Clearing filters brings the canvas back.
    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(screen.getByTestId("mock-canvas")).toBeInTheDocument();
  });
});
