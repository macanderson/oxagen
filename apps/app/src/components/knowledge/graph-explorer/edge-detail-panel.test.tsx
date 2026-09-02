// @vitest-environment jsdom
/**
 * edge-detail-panel.test.tsx — render + interaction tests for EdgeDetailPanel.
 *
 * Covers: relationship type, Inferred/Confirmed badge, ConfidenceMeter for
 * inferred edges, endpoint display names, clicking endpoints calls onSelectNode,
 * close button calls onClose.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { EdgeDetailPanel } from "./edge-detail-panel";
import type { ExplorerEdge, ExplorerNode } from "./types";

afterEach(cleanup);

const confirmedEdge: ExplorerEdge = {
  id: "a->b:RELATES_TO",
  source: "source-node-id",
  target: "target-node-id",
  type: "RELATES_TO",
  inferred: false,
};

const inferredEdge: ExplorerEdge = {
  id: "a->b:SIMILAR_TO",
  source: "source-node-id",
  target: "target-node-id",
  type: "SIMILAR_TO",
  inferred: true,
  confidence: 0.76,
};

const sourceNode: ExplorerNode = {
  id: "source-node-id",
  label: "Issue",
  displayName: "Bug Report",
  degree: 3,
  hydrated: true,
};

const targetNode: ExplorerNode = {
  id: "target-node-id",
  label: "Topic",
  displayName: "AI Research",
  degree: 1,
  hydrated: true,
};

describe("EdgeDetailPanel — confirmed edge", () => {
  it("renders the relationship type", () => {
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("RELATES_TO")).toBeInTheDocument();
  });

  it("renders 'Confirmed' badge", () => {
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Inferred")).not.toBeInTheDocument();
  });

  it("does not render ConfidenceMeter for a confirmed edge", () => {
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("renders the 'Confidence' section heading only for inferred edges (absent here)", () => {
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText("Confidence")).not.toBeInTheDocument();
  });
});

describe("EdgeDetailPanel — inferred edge", () => {
  it("renders 'Inferred' badge", () => {
    render(
      <EdgeDetailPanel
        edge={inferredEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Inferred")).toBeInTheDocument();
    expect(screen.queryByText("Confirmed")).not.toBeInTheDocument();
  });

  it("renders ConfidenceMeter (role='meter') for an inferred edge with confidence", () => {
    render(
      <EdgeDetailPanel
        edge={inferredEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("meter")).toBeInTheDocument();
  });

  it("renders the confidence percentage", () => {
    render(
      <EdgeDetailPanel
        edge={inferredEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // formatConfidence(0.76) → "76%"
    expect(screen.getByText("76%")).toBeInTheDocument();
  });

  it("does not render ConfidenceMeter when confidence is undefined", () => {
    const edge: ExplorerEdge = { ...inferredEdge, confidence: undefined };
    render(
      <EdgeDetailPanel edge={edge} onSelectNode={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });
});

describe("EdgeDetailPanel — endpoints", () => {
  it("renders source node displayName when sourceNode provided", () => {
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        sourceNode={sourceNode}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Bug Report")).toBeInTheDocument();
  });

  it("renders target node displayName when targetNode provided", () => {
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        targetNode={targetNode}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("AI Research")).toBeInTheDocument();
  });

  it("falls back to the raw nodeId when sourceNode is absent", () => {
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // When no sourceNode, the button text shows nodeId
    expect(screen.getAllByText("source-node-id").length).toBeGreaterThan(0);
  });

  it("clicking the source endpoint button calls onSelectNode with source nodeId", () => {
    const onSelectNode = vi.fn();
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        sourceNode={sourceNode}
        targetNode={targetNode}
        onSelectNode={onSelectNode}
        onClose={vi.fn()}
      />,
    );
    // The source button shows the displayName
    fireEvent.click(screen.getByText("Bug Report"));
    expect(onSelectNode).toHaveBeenCalledWith("source-node-id");
  });

  it("clicking the target endpoint button calls onSelectNode with target nodeId", () => {
    const onSelectNode = vi.fn();
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        sourceNode={sourceNode}
        targetNode={targetNode}
        onSelectNode={onSelectNode}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("AI Research"));
    expect(onSelectNode).toHaveBeenCalledWith("target-node-id");
  });

  it("renders 'Source' and 'Target' role labels", () => {
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        onSelectNode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Target")).toBeInTheDocument();
  });
});

describe("EdgeDetailPanel — close", () => {
  it("clicking the close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <EdgeDetailPanel
        edge={confirmedEdge}
        onSelectNode={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /close detail/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
