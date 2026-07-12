// @vitest-environment jsdom
/**
 * graph-side-panel.test.tsx
 *
 * Covers GraphSidePanel's own orchestration — stats fetch (loading/error/ready),
 * that Browse/Search/Query stay reachable regardless of nodeCount (the
 * zero-node "Connect a source" empty state is BrowsePanel's own concern, not a
 * workspace-wide gate — see browse-panel.test.tsx), and the Export flow
 * (success + failure toasts, disabled while stats aren't ready or the graph is
 * empty). Browse/Search/Query panels are stubbed — they have their own
 * dedicated test files — so assertions target GraphSidePanel's wiring.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { mockGraphStats, mockExportGraph, mockAddToast } = vi.hoisted(() => ({
  mockGraphStats: vi.fn(),
  mockExportGraph: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock("../actions", () => ({
  graphStatsAction: mockGraphStats,
  exportGraphAction: mockExportGraph,
}));

vi.mock("@/lib/tenant/tenant-context", () => ({
  useTenant: () => ({
    orgId: "org-1",
    orgSlug: "acme",
    orgName: "Acme",
    workspaceId: "ws-1",
    workspaceSlug: "core",
    workspaceName: "Core",
  }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

// Dumb, non-interactive Tabs mock (established pattern — see
// workspace-context-panel.test.tsx): renders every TabsPanel unconditionally,
// stamps the controlled `value` onto the root.
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <div data-testid="tabs-root" data-active={value}>
      {children}
    </div>
  ),
  TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
  TabsTab: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button role="tab" data-value={value} type="button">
      {children}
    </button>
  ),
  TabsPanel: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div role="tabpanel" data-value={value}>
      {children}
    </div>
  ),
}));

vi.mock("./browse-panel", () => ({
  BrowsePanel: ({ availableLabels }: { availableLabels: string[] }) => (
    <div data-testid="browse-panel">labels: {availableLabels.join(",")}</div>
  ),
}));
vi.mock("./search-panel", () => ({
  SearchPanel: () => <div data-testid="search-panel" />,
}));
vi.mock("./query-console", () => ({
  QueryConsole: () => <div data-testid="query-console" />,
}));

import { GraphSidePanel } from "./graph-side-panel";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => "blob:mock");
  global.URL.revokeObjectURL = vi.fn();
});

const READY_STATS = {
  ok: true as const,
  stats: {
    nodeCount: 42,
    edgeCount: 10,
    inferredEdgeCount: 2,
    sourceCount: 1,
    nodesByLabel: { Feature: 30, Issue: 12 },
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("GraphSidePanel", () => {
  it("loads stats and renders the count boxes + all three panels", async () => {
    mockGraphStats.mockResolvedValue(READY_STATS);
    render(<GraphSidePanel />);

    await waitFor(() => expect(screen.getByTestId("graph-stats")).toBeInTheDocument());
    expect(mockGraphStats).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: "acme", workspaceSlug: "core", includeByType: true }),
    );
    expect(screen.getByTestId("browse-panel")).toHaveTextContent("labels: Feature,Issue");
    expect(screen.getByTestId("search-panel")).toBeInTheDocument();
    expect(screen.getByTestId("query-console")).toBeInTheDocument();
  });

  it("shows an error state with retry when stats fail to load", async () => {
    mockGraphStats.mockResolvedValueOnce({ ok: false, error: "neo4j down" });
    render(<GraphSidePanel />);
    await waitFor(() => expect(screen.getByText("neo4j down")).toBeInTheDocument());

    mockGraphStats.mockResolvedValueOnce(READY_STATS);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByTestId("graph-stats")).toBeInTheDocument());
  });

  it("keeps Browse/Search/Query reachable even when nodeCount is 0 — the empty state is BrowsePanel's concern, not a workspace-wide gate", async () => {
    mockGraphStats.mockResolvedValue({
      ok: true,
      stats: { nodeCount: 0, edgeCount: 0, inferredEdgeCount: 0, sourceCount: 0 },
    });
    render(<GraphSidePanel />);
    await waitFor(() => expect(screen.getByTestId("graph-stats")).toBeInTheDocument());
    // All three tabs/panels still mount — Search and the Query console (Cypher
    // and ontology traversal) don't require ingested customer data to be useful.
    expect(screen.getByTestId("browse-panel")).toBeInTheDocument();
    expect(screen.getByTestId("search-panel")).toBeInTheDocument();
    expect(screen.getByTestId("query-console")).toBeInTheDocument();
    // Export has nothing to export at nodeCount 0.
    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled();
  });

  it("Export is disabled until stats are ready, and hits export_graph with the active label scope", async () => {
    mockGraphStats.mockResolvedValue(READY_STATS);
    mockExportGraph.mockResolvedValue({
      ok: true,
      nodes: [{ id: "pub-1" }],
      edges: [],
      total: 1,
    });
    render(<GraphSidePanel />);

    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: /export/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    await waitFor(() => expect(mockExportGraph).toHaveBeenCalled());
    expect(mockExportGraph).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: "acme", workspaceSlug: "core", includeEdges: true }),
    );
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Export ready", type: "success" }),
      ),
    );
  });

  it("shows an error toast when export fails", async () => {
    mockGraphStats.mockResolvedValue(READY_STATS);
    mockExportGraph.mockResolvedValue({ ok: false, error: "export failed" });
    render(<GraphSidePanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: /export/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Export failed", description: "export failed", type: "error" }),
      ),
    );
  });
});
