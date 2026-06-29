// @vitest-environment jsdom
/**
 * type-filter-panel.test.tsx — render + interaction tests for TypeFilterPanel.
 *
 * Covers: node type names/counts, edge type names/counts, checkbox toggle
 * callbacks for node/edge types, All/None bulk-action buttons, inferred
 * edge row state and toggle callback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TypeFilterPanel, type TypeFilterPanelProps } from "./type-filter-panel";

afterEach(cleanup);

function makeProps(overrides: Partial<TypeFilterPanelProps> = {}): TypeFilterPanelProps {
  return {
    nodeCounts: [
      { type: "Issue", count: 12 },
      { type: "Topic", count: 5 },
    ],
    edgeCounts: [{ type: "RELATES_TO", count: 8 }],
    hiddenNodeTypes: new Set<string>(),
    hiddenEdgeTypes: new Set<string>(),
    inferredHidden: false,
    systemHidden: false,
    inferredCount: 3,
    confirmedCount: 9,
    onToggleNodeType: vi.fn(),
    onToggleEdgeType: vi.fn(),
    onToggleInferred: vi.fn(),
    onToggleSystem: vi.fn(),
    onShowAllNodeTypes: vi.fn(),
    onHideAllNodeTypes: vi.fn(),
    ...overrides,
  };
}

describe("TypeFilterPanel — rendering", () => {
  it("renders node type names and counts", () => {
    render(<TypeFilterPanel {...makeProps()} />);
    expect(screen.getByText("Issue")).toBeInTheDocument();
    expect(screen.getByText("Topic")).toBeInTheDocument();
    // counts rendered as locale strings
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("renders edge relationship type names", () => {
    render(<TypeFilterPanel {...makeProps()} />);
    expect(screen.getByText("RELATES_TO")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
  });

  it("renders 'Inferred' and 'Confirmed' edge source rows", () => {
    render(<TypeFilterPanel {...makeProps()} />);
    expect(screen.getByText("Inferred")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
  });

  it("renders inferred count and confirmed count", () => {
    render(<TypeFilterPanel {...makeProps({ inferredCount: 7, confirmedCount: 9 })} />);
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
  });

  it("renders 'No nodes in view.' when nodeCounts is empty", () => {
    render(<TypeFilterPanel {...makeProps({ nodeCounts: [] })} />);
    expect(screen.getByText("No nodes in view.")).toBeInTheDocument();
  });

  it("renders 'No relationships in view.' when edgeCounts is empty", () => {
    render(<TypeFilterPanel {...makeProps({ edgeCounts: [] })} />);
    expect(screen.getByText("No relationships in view.")).toBeInTheDocument();
  });
});

describe("TypeFilterPanel — node type callbacks", () => {
  it("calls onToggleNodeType with the type when a node label row is clicked", () => {
    const onToggleNodeType = vi.fn();
    render(<TypeFilterPanel {...makeProps({ onToggleNodeType })} />);
    fireEvent.click(screen.getByText("Issue"));
    expect(onToggleNodeType).toHaveBeenCalledWith("Issue");
  });

  it("calls onToggleNodeType with 'Topic' when that row is clicked", () => {
    const onToggleNodeType = vi.fn();
    render(<TypeFilterPanel {...makeProps({ onToggleNodeType })} />);
    fireEvent.click(screen.getByText("Topic"));
    expect(onToggleNodeType).toHaveBeenCalledWith("Topic");
  });

  it("calls onShowAllNodeTypes when the 'All' button is clicked", () => {
    const onShowAllNodeTypes = vi.fn();
    render(<TypeFilterPanel {...makeProps({ onShowAllNodeTypes })} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onShowAllNodeTypes).toHaveBeenCalledOnce();
  });

  it("calls onHideAllNodeTypes when the 'None' button is clicked", () => {
    const onHideAllNodeTypes = vi.fn();
    render(<TypeFilterPanel {...makeProps({ onHideAllNodeTypes })} />);
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(onHideAllNodeTypes).toHaveBeenCalledOnce();
  });
});

describe("TypeFilterPanel — edge type callbacks", () => {
  it("calls onToggleEdgeType with the type when an edge type row is clicked", () => {
    const onToggleEdgeType = vi.fn();
    render(<TypeFilterPanel {...makeProps({ onToggleEdgeType })} />);
    fireEvent.click(screen.getByText("RELATES_TO"));
    expect(onToggleEdgeType).toHaveBeenCalledWith("RELATES_TO");
  });
});

describe("TypeFilterPanel — inferred toggle", () => {
  it("calls onToggleInferred when the Inferred row is clicked", () => {
    const onToggleInferred = vi.fn();
    render(<TypeFilterPanel {...makeProps({ onToggleInferred })} />);
    fireEvent.click(screen.getByText("Inferred"));
    expect(onToggleInferred).toHaveBeenCalledOnce();
  });

  it("reflects inferredHidden=true by marking the inferred row as hidden", () => {
    // When inferredHidden is true, the Checkbox for Inferred is unchecked.
    // We verify by checking the aria state — Base UI checkbox uses data-[checked].
    const { container } = render(
      <TypeFilterPanel {...makeProps({ inferredHidden: true })} />,
    );
    // The first list in "Edge source" section has 2 rows: Inferred and Confirmed.
    // We can check the checkboxes rendered; the first one should not have data-[checked].
    const checkboxes = container.querySelectorAll('[role="checkbox"]');
    // Find the Inferred checkbox (first in edge source section)
    // Its data-[checked] attribute should be absent when inferredHidden=true
    const inferredCheckbox = checkboxes[2]; // 2 node checkboxes + inferred (index 2)
    expect(inferredCheckbox).not.toHaveAttribute("data-checked");
  });

  it("reflects inferredHidden=false by marking the inferred row as visible", () => {
    const { container } = render(
      <TypeFilterPanel {...makeProps({ inferredHidden: false })} />,
    );
    const checkboxes = container.querySelectorAll('[role="checkbox"]');
    const inferredCheckbox = checkboxes[2];
    expect(inferredCheckbox).toHaveAttribute("data-checked", "");
  });
});
