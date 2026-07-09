// @vitest-environment jsdom
/**
 * execution-lineage-canvas.test.tsx
 *
 * Verifies the lineage canvas maps an execution + its touched files onto the
 * shared graph canvas (one execution node + one node/edge per file) and cites
 * each touched file as an inspectable NodeRef chip.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ExecutionLineageCanvas } from "./execution-lineage-canvas";

afterEach(cleanup);

// Stub the WebGL canvas: capture the node/edge counts it is handed without
// rendering reagenraph in jsdom.
vi.mock("next/dynamic", () => ({
  default: () =>
    function GraphCanvasStub(props: {
      nodes: unknown[];
      edges: unknown[];
      selectedId: string | null;
    }) {
      return (
        <div
          data-testid="graph-canvas"
          data-node-count={props.nodes.length}
          data-edge-count={props.edges.length}
          data-selected={props.selectedId ?? ""}
        />
      );
    },
}));

// NodeRef has its own tests — stub it so assertions target the lineage wiring.
vi.mock("@/components/knowledge/graph/node-ref", () => ({
  NodeRef: ({ node }: { node: { displayName: string } }) => (
    <span data-testid="node-ref">{node.displayName}</span>
  ),
}));

const EXECUTION = {
  id: "aex_run1",
  label: "Execution",
  displayName: "chat execution by planner",
  properties: { status: "completed", originType: "agent_coding_turn" },
};

const FILES = [
  {
    node: {
      id: "github:oxageninc/oxagen-platform:src/a.ts",
      label: "SourceFile",
      displayName: "src/a.ts",
      properties: { path: "src/a.ts" },
    },
    edgeType: "TOUCHED_FILE",
  },
  {
    node: {
      id: "github:oxageninc/oxagen-platform:src/b.ts",
      label: "SourceFile",
      displayName: "src/b.ts",
      properties: { path: "src/b.ts" },
    },
    edgeType: "TOUCHED_FILE",
  },
];

describe("ExecutionLineageCanvas", () => {
  it("renders the lineage header with the touched-file count", () => {
    render(<ExecutionLineageCanvas execution={EXECUTION} files={FILES} />);
    expect(screen.getByText("Execution file lineage")).toBeInTheDocument();
    expect(screen.getByText(/2 files touched/)).toBeInTheDocument();
  });

  it("hands the canvas one execution node plus one node + edge per touched file", () => {
    render(<ExecutionLineageCanvas execution={EXECUTION} files={FILES} />);
    const canvas = screen.getByTestId("graph-canvas");
    // 1 execution + 2 files.
    expect(canvas).toHaveAttribute("data-node-count", "3");
    // one TOUCHED_FILE edge per file.
    expect(canvas).toHaveAttribute("data-edge-count", "2");
    // centered on the execution node.
    expect(canvas).toHaveAttribute("data-selected", "aex_run1");
  });

  it("cites every touched file as an inspectable NodeRef chip", () => {
    render(<ExecutionLineageCanvas execution={EXECUTION} files={FILES} />);
    const chips = screen.getAllByTestId("node-ref");
    expect(chips).toHaveLength(2);
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
  });

  it("renders the canvas with no file chips when nothing was touched", () => {
    render(<ExecutionLineageCanvas execution={EXECUTION} files={[]} />);
    const canvas = screen.getByTestId("graph-canvas");
    expect(canvas).toHaveAttribute("data-node-count", "1");
    expect(canvas).toHaveAttribute("data-edge-count", "0");
    expect(screen.queryByTestId("node-ref")).not.toBeInTheDocument();
    expect(screen.getByText(/0 files touched/)).toBeInTheDocument();
  });
});
