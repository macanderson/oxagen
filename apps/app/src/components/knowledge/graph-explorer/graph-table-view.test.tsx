// @vitest-environment jsdom
/**
 * graph-table-view.test.tsx — render + interaction tests for GraphTableView.
 *
 * Covers: initial node load, row click → onSelectNode, search debounce triggers
 * fetchNodes with query, Prev disabled on first page, Next disabled when
 * hasMore=false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { GraphTableView } from "./graph-table-view";
import { fetchNodes } from "./api-client";

afterEach(cleanup);

vi.mock("./api-client", () => ({
  fetchNodes: vi.fn(),
}));

const mockFetch = vi.mocked(fetchNodes);

const singleNode = {
  nodes: [
    {
      id: "n1",
      label: "Issue",
      displayName: "Bug #1",
      degree: 0,
      hydrated: true,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ],
  total: 1,
  hasMore: false,
  limit: 25,
  offset: 0,
};

const tenant = { orgSlug: "acme", workspaceSlug: "main" };

beforeEach(() => {
  mockFetch.mockResolvedValue(singleNode);
});

describe("GraphTableView — initial load", () => {
  it("renders the node displayName after load", async () => {
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Bug #1")).toBeInTheDocument());
  });

  it("renders column headers", async () => {
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("ID")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
  });

  it("shows node count in the header area after load", async () => {
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("1 node")).toBeInTheDocument());
  });
});

describe("GraphTableView — row selection", () => {
  it("clicking a row calls onSelectNode with the node id", async () => {
    const onSelectNode = vi.fn();
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
      />,
    );
    await waitFor(() => expect(screen.getByText("Bug #1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Bug #1"));
    expect(onSelectNode).toHaveBeenCalledWith("n1");
  });

  it("selected row gets aria-selected attribute", async () => {
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId="n1"
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Bug #1")).toBeInTheDocument());
    const row = screen.getByText("Bug #1").closest("tr");
    expect(row).toHaveAttribute("aria-selected", "true");
  });
});

describe("GraphTableView — empty state", () => {
  it("renders 'No nodes match.' when result is empty", async () => {
    mockFetch.mockResolvedValue({
      nodes: [],
      total: 0,
      hasMore: false,
      limit: 25,
      offset: 0,
    });
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("No nodes match.")).toBeInTheDocument(),
    );
  });

  it("renders 'Failed to load nodes.' on error", async () => {
    mockFetch.mockRejectedValue(new Error("Server error"));
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Failed to load nodes.")).toBeInTheDocument(),
    );
  });
});

describe("GraphTableView — pagination", () => {
  it("Prev button is disabled on the first page (offset=0)", async () => {
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Bug #1")).toBeInTheDocument());
    const prevBtn = screen.getByRole("button", { name: /prev/i });
    expect(prevBtn).toBeDisabled();
  });

  it("Next button is disabled when hasMore=false", async () => {
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Bug #1")).toBeInTheDocument());
    const nextBtn = screen.getByRole("button", { name: /next/i });
    expect(nextBtn).toBeDisabled();
  });

  it("Next button is enabled when hasMore=true", async () => {
    mockFetch.mockResolvedValue({
      nodes: [
        {
          id: "n1",
          label: "Issue",
          displayName: "Bug #1",
          degree: 0,
          hydrated: true,
        },
      ],
      total: 50,
      hasMore: true,
      limit: 25,
      offset: 0,
    });
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Bug #1")).toBeInTheDocument());
    const nextBtn = screen.getByRole("button", { name: /next/i });
    expect(nextBtn).not.toBeDisabled();
  });
});

describe("GraphTableView — search debounce", () => {
  it("typing into the search input eventually calls fetchNodes with the query", async () => {
    render(
      <GraphTableView
        tenant={tenant}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />,
    );
    // Wait for initial load
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const searchInput = screen.getByRole("textbox", { name: /search nodes/i });
    fireEvent.change(searchInput, { target: { value: "login bug" } });

    // Wait for debounce (300ms) and fetch to be called with the query
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall?.[1]).toMatchObject({ query: "login bug" });
      },
      { timeout: 1000 },
    );
  });
});
