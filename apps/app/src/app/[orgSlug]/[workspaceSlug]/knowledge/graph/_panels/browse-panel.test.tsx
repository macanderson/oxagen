// @vitest-environment jsdom
/**
 * browse-panel.test.tsx
 *
 * Covers: initial load, label-chip filter refetch, client-side sort, expand
 * neighborhood on demand, pagination, error + retry, and the no-match empty
 * state. NodeRef and next/link are stubbed (their own behavior is covered by
 * node-ref.test.tsx / graph-result-row.test.tsx) so assertions target
 * BrowsePanel's own data-fetch and interaction wiring.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";

const { mockListNodes, mockOntologyNeighbors } = vi.hoisted(() => ({
  mockListNodes: vi.fn(),
  mockOntologyNeighbors: vi.fn(),
}));

vi.mock("../actions", () => ({
  listNodesAction: mockListNodes,
  ontologyNeighborsAction: mockOntologyNeighbors,
}));

vi.mock("@/components/knowledge/graph/node-ref", () => ({
  NodeRef: ({ node }: { node: { displayName: string } }) => (
    <span data-testid="node-ref">{node.displayName}</span>
  ),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

// `@/components/ui/select` mocked to a plain clickable stand-in — the
// established pattern in this repo (see list-toolbar.test.tsx /
// environment-selector.test.tsx) since the real Base UI Select renders
// through a portal and isn't worth exercising again here.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange?: (v: string) => void;
  }) => (
    <div>
      {children}
      <button
        type="button"
        aria-label="Sort: Name (A–Z)"
        onClick={() => onValueChange?.("name")}
      />
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <div data-value={value}>{children}</div>,
}));

import { BrowsePanel } from "./browse-panel";

afterEach(cleanup);

function node(
  overrides: Partial<{
    id: string;
    labels: string[];
    displayName: string;
    createdAt: string;
  }> = {},
) {
  return {
    id: "pub-1",
    labels: ["Feature"],
    properties: {},
    displayName: "Node A",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListNodes.mockResolvedValue({
    ok: true,
    nodes: [node()],
    total: 1,
    hasMore: false,
    limit: 25,
    offset: 0,
  });
});

describe("BrowsePanel", () => {
  it("loads and renders nodes on mount", async () => {
    render(
      <BrowsePanel orgSlug="acme" workspaceSlug="core" availableLabels={[]} />,
    );
    await waitFor(() => expect(screen.getByText("Node A")).toBeInTheDocument());
    expect(mockListNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "core",
        limit: 25,
        offset: 0,
      }),
    );
  });

  it("shows 'Connect a source' when the graph is genuinely empty (zero total, no filter)", async () => {
    mockListNodes.mockResolvedValue({
      ok: true,
      nodes: [],
      total: 0,
      hasMore: false,
      limit: 25,
      offset: 0,
    });
    render(
      <BrowsePanel orgSlug="acme" workspaceSlug="core" availableLabels={[]} />,
    );
    await waitFor(() =>
      expect(screen.getByText("Connect a source")).toBeInTheDocument(),
    );
    const link = screen.getByRole("link", { name: /go to sources/i });
    expect(link).toHaveAttribute("href", "/acme/core/knowledge/sources");
  });

  it("shows the narrower no-match empty state when a label filter yields zero results", async () => {
    mockListNodes.mockResolvedValue({
      ok: true,
      nodes: [],
      total: 0,
      hasMore: false,
      limit: 25,
      offset: 0,
    });
    render(
      <BrowsePanel
        orgSlug="acme"
        workspaceSlug="core"
        availableLabels={["Feature"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Feature" }));
    await waitFor(() =>
      expect(
        screen.getByText("No nodes match this filter"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Connect a source")).not.toBeInTheDocument();
  });

  it("shows an error state with a working retry", async () => {
    mockListNodes.mockResolvedValueOnce({
      ok: false,
      error: "graph unavailable",
    });
    render(
      <BrowsePanel orgSlug="acme" workspaceSlug="core" availableLabels={[]} />,
    );
    await waitFor(() =>
      expect(screen.getByText("graph unavailable")).toBeInTheDocument(),
    );

    mockListNodes.mockResolvedValueOnce({
      ok: true,
      nodes: [node()],
      total: 1,
      hasMore: false,
      limit: 25,
      offset: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByText("Node A")).toBeInTheDocument());
  });

  it("toggling a label chip refetches with that label and calls onLabelsChange", async () => {
    const onLabelsChange = vi.fn();
    render(
      <BrowsePanel
        orgSlug="acme"
        workspaceSlug="core"
        availableLabels={["Feature", "Issue"]}
        onLabelsChange={onLabelsChange}
      />,
    );
    await waitFor(() => expect(screen.getByText("Node A")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Feature" }));
    await waitFor(() =>
      expect(mockListNodes).toHaveBeenLastCalledWith(
        expect.objectContaining({ labels: ["Feature"], offset: 0 }),
      ),
    );
    expect(onLabelsChange).toHaveBeenLastCalledWith(["Feature"]);
  });

  it("paginates forward and back using Prev/Next", async () => {
    mockListNodes.mockResolvedValue({
      ok: true,
      nodes: [node()],
      total: 60,
      hasMore: true,
      limit: 25,
      offset: 0,
    });
    render(
      <BrowsePanel orgSlug="acme" workspaceSlug="core" availableLabels={[]} />,
    );
    await waitFor(() => expect(screen.getByText("Node A")).toBeInTheDocument());

    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(screen.getByRole("button", { name: /prev/i })).toBeDisabled();

    fireEvent.click(nextButton);
    await waitFor(() =>
      expect(mockListNodes).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 25 }),
      ),
    );
  });

  it("expands a node's neighborhood on demand and caches the result", async () => {
    mockOntologyNeighbors.mockResolvedValue({
      ok: true,
      nodeId: "pub-1",
      found: true,
      truncated: false,
      neighbors: [
        {
          nodeId: "pub-2",
          label: "Person",
          displayName: "Neighbor A",
          description: null,
          edgeType: "OWNS",
          direction: "out",
          validFrom: null,
          validTo: null,
          recordedAt: null,
          invalidatedAt: null,
        },
      ],
    });
    render(
      <BrowsePanel orgSlug="acme" workspaceSlug="core" availableLabels={[]} />,
    );
    await waitFor(() => expect(screen.getByText("Node A")).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole("button", { name: /expand node a neighbors/i }),
    );
    await waitFor(() =>
      expect(screen.getByText("Neighbor A")).toBeInTheDocument(),
    );
    expect(mockOntologyNeighbors).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "core",
        nodeId: "pub-1",
      }),
    );

    // Collapse then re-expand — cached, no second fetch.
    fireEvent.click(
      screen.getByRole("button", { name: /collapse node a neighbors/i }),
    );
    expect(screen.queryByText("Neighbor A")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /expand node a neighbors/i }),
    );
    await waitFor(() =>
      expect(screen.getByText("Neighbor A")).toBeInTheDocument(),
    );
    expect(mockOntologyNeighbors).toHaveBeenCalledTimes(1);
  });

  it("sorts client-side by name when the sort mode changes", async () => {
    mockListNodes.mockResolvedValue({
      ok: true,
      nodes: [
        node({
          id: "pub-b",
          displayName: "Bravo",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
        node({
          id: "pub-a",
          displayName: "Alpha",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      total: 2,
      hasMore: false,
      limit: 25,
      offset: 0,
    });
    render(
      <BrowsePanel orgSlug="acme" workspaceSlug="core" availableLabels={[]} />,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("node-ref")).toHaveLength(2),
    );

    // Default "recent" sort: Bravo (newer createdAt) first.
    let refs = screen.getAllByTestId("node-ref");
    expect(
      within(refs[0] as HTMLElement).getByText("Bravo"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sort: Name (A–Z)" }));

    await waitFor(() => {
      refs = screen.getAllByTestId("node-ref");
      expect(
        within(refs[0] as HTMLElement).getByText("Alpha"),
      ).toBeInTheDocument();
    });
  });
});
