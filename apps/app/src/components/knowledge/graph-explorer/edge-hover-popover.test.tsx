// @vitest-environment jsdom
/**
 * edge-hover-popover.test.tsx — render tests for EdgeHoverPopover.
 *
 * Covers: role="tooltip" presence, edge type, inferred/confirmed badge,
 * source/target display names when nodes provided, raw id fallback when nodes
 * absent, confidence percentage for inferred edges.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EdgeHoverPopover } from "./edge-hover-popover";
import type { ExplorerEdge, ExplorerNode } from "./types";

afterEach(cleanup);

const confirmedEdge: ExplorerEdge = {
  id: "a->b:RELATES_TO",
  source: "a",
  target: "b",
  type: "RELATES_TO",
  inferred: false,
};

const inferredEdge: ExplorerEdge = {
  id: "a->b:SIMILAR_TO",
  source: "a",
  target: "b",
  type: "SIMILAR_TO",
  inferred: true,
  confidence: 0.82,
};

const sourceNode: ExplorerNode = {
  id: "a",
  label: "Issue",
  displayName: "Bug #42",
  degree: 2,
  hydrated: true,
};

const targetNode: ExplorerNode = {
  id: "b",
  label: "Topic",
  displayName: "AI Safety",
  degree: 1,
  hydrated: true,
};

const pos = { x: 100, y: 200 };

describe("EdgeHoverPopover — structure", () => {
  it("renders a role='tooltip' element", () => {
    render(<EdgeHoverPopover edge={confirmedEdge} pos={pos} />);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("renders the edge type", () => {
    render(<EdgeHoverPopover edge={confirmedEdge} pos={pos} />);
    expect(screen.getByText("RELATES_TO")).toBeInTheDocument();
  });
});

describe("EdgeHoverPopover — confirmed edge", () => {
  it("renders 'Confirmed' badge for a non-inferred edge", () => {
    render(<EdgeHoverPopover edge={confirmedEdge} pos={pos} />);
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Inferred")).not.toBeInTheDocument();
  });

  it("does not render a confidence row for a confirmed edge", () => {
    render(<EdgeHoverPopover edge={confirmedEdge} pos={pos} />);
    expect(screen.queryByText("Confidence")).not.toBeInTheDocument();
  });
});

describe("EdgeHoverPopover — inferred edge", () => {
  it("renders 'Inferred' badge for an inferred edge", () => {
    render(<EdgeHoverPopover edge={inferredEdge} pos={pos} />);
    expect(screen.getByText("Inferred")).toBeInTheDocument();
  });

  it("renders the confidence percentage for an inferred edge", () => {
    render(<EdgeHoverPopover edge={inferredEdge} pos={pos} />);
    // formatConfidence(0.82) → "82%"
    expect(screen.getByText("82%")).toBeInTheDocument();
  });

  it("does not render confidence when edge.confidence is undefined", () => {
    const edge: ExplorerEdge = { ...inferredEdge, confidence: undefined };
    render(<EdgeHoverPopover edge={edge} pos={pos} />);
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });
});

describe("EdgeHoverPopover — source/target display", () => {
  it("shows sourceNode displayName when sourceNode is provided", () => {
    render(
      <EdgeHoverPopover
        edge={confirmedEdge}
        pos={pos}
        sourceNode={sourceNode}
      />,
    );
    expect(screen.getByText("Bug #42")).toBeInTheDocument();
  });

  it("shows targetNode displayName when targetNode is provided", () => {
    render(
      <EdgeHoverPopover
        edge={confirmedEdge}
        pos={pos}
        targetNode={targetNode}
      />,
    );
    expect(screen.getByText("AI Safety")).toBeInTheDocument();
  });

  it("shows both source and target display names when both nodes provided", () => {
    render(
      <EdgeHoverPopover
        edge={confirmedEdge}
        pos={pos}
        sourceNode={sourceNode}
        targetNode={targetNode}
      />,
    );
    expect(screen.getByText("Bug #42")).toBeInTheDocument();
    expect(screen.getByText("AI Safety")).toBeInTheDocument();
  });

  it("falls back to truncated edge.source when sourceNode is absent", () => {
    render(<EdgeHoverPopover edge={confirmedEdge} pos={pos} />);
    // truncate("a", 24) → "a"
    expect(screen.getByText("a")).toBeInTheDocument();
  });

  it("falls back to truncated edge.target when targetNode is absent", () => {
    render(<EdgeHoverPopover edge={confirmedEdge} pos={pos} />);
    expect(screen.getByText("b")).toBeInTheDocument();
  });
});

describe("EdgeHoverPopover — property values", () => {
  it("renders nested object/array property values readably, never '[object Object]'", () => {
    const withProps: ExplorerNode = {
      ...sourceNode,
      properties: {
        meta: { status: "open" },
        tags: ["auth", "billing"],
        title: "Login broken",
      },
    };
    const { container } = render(
      <EdgeHoverPopover
        edge={confirmedEdge}
        pos={pos}
        sourceNode={withProps}
      />,
    );
    expect(container.textContent).not.toContain("[object Object]");
    // formatPropertyValue then truncate(…, 20): objects render as compact JSON,
    // arrays comma-joined, strings as-is.
    expect(container.textContent).toContain('{"status":"open"}');
    expect(container.textContent).toContain("auth, billing");
    expect(container.textContent).toContain("Login broken");
  });

  it("truncates long formatted values to the 20-char budget", () => {
    const withProps: ExplorerNode = {
      ...targetNode,
      properties: {
        description: "a".repeat(60),
      },
    };
    const { container } = render(
      <EdgeHoverPopover
        edge={confirmedEdge}
        pos={pos}
        targetNode={withProps}
      />,
    );
    // truncate(value, 20) → 19 chars + ellipsis.
    expect(container.textContent).toContain(`${"a".repeat(19)}…`);
    expect(container.textContent).not.toContain("a".repeat(21));
  });
});
