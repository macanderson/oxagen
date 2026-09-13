// @vitest-environment jsdom
/**
 * node-detail-panel.test.tsx — render + interaction tests for NodeDetailPanel.
 *
 * Covers: fallback label/displayName while loading, property rendering after
 * load, neighbor display, clicking a neighbor calls onSelectNode, Expand
 * neighbours calls onExpand, Close calls onClose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { NodeDetailPanel } from "./node-detail-panel";
import { fetchNodeDetail } from "./api-client";

afterEach(cleanup);

vi.mock("./api-client", () => ({
  fetchNodeDetail: vi.fn(),
}));

const mockFetchDetail = vi.mocked(fetchNodeDetail);

const detailPayload = {
  node: {
    id: "n1",
    label: "Issue",
    displayName: "Bug #42",
    properties: { priority: "high", status: "open" },
    degree: 2,
    hydrated: true,
  },
  neighbors: [
    {
      nodeId: "n2",
      label: "Topic",
      displayName: "AI Safety",
      edgeType: "RELATED_TO",
      direction: "out" as const,
    },
  ],
};

const tenant = { orgSlug: "acme", workspaceSlug: "main" };

beforeEach(() => {
  mockFetchDetail.mockResolvedValue(detailPayload);
});

describe("NodeDetailPanel — fallback header", () => {
  it("shows the fallback displayName immediately before load completes", () => {
    // Never resolve so we stay in loading state
    mockFetchDetail.mockReturnValue(new Promise(() => undefined));
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        fallback={{ label: "Issue", displayName: "Fallback Name" }}
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Fallback Name")).toBeInTheDocument();
  });

  it("shows the fallback label in the badge before load", () => {
    mockFetchDetail.mockReturnValue(new Promise(() => undefined));
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        fallback={{ label: "Issue", displayName: "Fallback Name" }}
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Issue")).toBeInTheDocument();
  });
});

describe("NodeDetailPanel — after load", () => {
  it("shows the loaded displayName", async () => {
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("Bug #42")).toBeInTheDocument(),
    );
  });

  it("renders node properties after load", async () => {
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("high")).toBeInTheDocument());
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("renders neighbor displayName after load", async () => {
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("AI Safety")).toBeInTheDocument(),
    );
  });

  it("renders the neighbor edge type label", async () => {
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("RELATED_TO")).toBeInTheDocument(),
    );
  });
});

describe("NodeDetailPanel — interactions", () => {
  it("clicking a neighbor calls onSelectNode with neighbor nodeId", async () => {
    const onSelectNode = vi.fn();
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={onSelectNode}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("AI Safety")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("AI Safety"));
    expect(onSelectNode).toHaveBeenCalledWith("n2");
  });

  it("clicking 'Expand neighbours' calls onExpand with nodeId", async () => {
    const onExpand = vi.fn();
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={vi.fn()}
        onExpand={onExpand}
        onClose={vi.fn()}
      />,
    );
    // The button is rendered immediately, no need to wait
    const expandBtn = screen.getByRole("button", {
      name: /expand neighbours/i,
    });
    fireEvent.click(expandBtn);
    expect(onExpand).toHaveBeenCalledWith("n1");
  });

  it("clicking the close button calls onClose", async () => {
    const onClose = vi.fn();
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /close detail/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("NodeDetailPanel — no neighbors", () => {
  it("renders 'No connected entities.' when neighbors array is empty", async () => {
    mockFetchDetail.mockResolvedValue({ ...detailPayload, neighbors: [] });
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("No connected entities.")).toBeInTheDocument(),
    );
  });
});

describe("NodeDetailPanel — error state", () => {
  it("shows error message when fetch fails", async () => {
    mockFetchDetail.mockRejectedValue(new Error("Network error"));
    render(
      <NodeDetailPanel
        tenant={tenant}
        nodeId="n1"
        onSelectNode={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("Failed to load node detail."),
      ).toBeInTheDocument(),
    );
  });
});
