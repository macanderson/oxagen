// @vitest-environment jsdom
/**
 * lineage-canvas-view.test.tsx — render tests for LineageCanvasView (default
 * export). Mirrors
 * @/components/knowledge/graph-explorer/graph-canvas-view.test.tsx's mocking
 * strategy: reagraph renders WebGL, which jsdom cannot run, so the whole
 * module is mocked and the mock captures the props passed to GraphCanvas.
 * The interesting node/edge VISUAL encoding (violation colour/flag, spend
 * sizing, parent→child wiring) is covered directly and without rendering in
 * lib/lineage/canvas-map.test.ts — this file only proves the component wires
 * that pure output through to reagraph, plus the onApiReady contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { LineageNodeDto } from "@oxagen/oxagen/contracts/lineage.query";

afterEach(cleanup);

interface StoredProps {
  nodes: Array<{ id: string; fill: string; label: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
  selections: string[];
  layoutType: string;
  onNodeClick: ((node: { id: string }) => void) | undefined;
  onCanvasClick: (() => void) | undefined;
}

let storedProps: StoredProps | null = null;
let storedRefCallback: ((instance: unknown) => void) | null = null;

vi.mock("reagraph", () => ({
  GraphCanvas: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any, ref: any) => {
      storedProps = props;
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

import LineageCanvasView from "./lineage-canvas-view";

function node(
  overrides: Partial<LineageNodeDto> & { runId: string },
): LineageNodeDto {
  return {
    fanoutId: "fanout-1",
    parentRunId: null,
    childFanoutId: null,
    depth: 0,
    capabilityName: "search_web",
    outcome: "completed",
    attempts: 1,
    principal: { id: "p1", kind: "agent", displayName: "Ops Agent" },
    delegationCeiling: null,
    model: "claude-sonnet-5",
    provider: "anthropic",
    spend: { costUsd: 0, inputTokens: 0, outputTokens: 0, llmCalls: 0 },
    delegationViolation: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

const defaultProps = {
  nodes: [node({ runId: "run-1" })],
  dispatchId: "sfo_abc123",
  selectedRunId: null,
  isDark: false,
  onSelectRun: vi.fn(),
  onClearSelection: vi.fn(),
  onApiReady: vi.fn(),
};

describe("LineageCanvasView — mapping pass-through", () => {
  it("includes the synthetic root plus every input node", () => {
    render(<LineageCanvasView {...defaultProps} />);
    expect(storedProps?.nodes.map((n) => n.id)).toEqual([
      "__lineage_root__",
      "run-1",
    ]);
  });

  it("uses treeTd2d as the layout type (hierarchical, not force-directed)", () => {
    render(<LineageCanvasView {...defaultProps} />);
    expect(storedProps?.layoutType).toBe("treeTd2d");
  });

  it("passes the selected run id through to reagraph selections", () => {
    render(<LineageCanvasView {...defaultProps} selectedRunId="run-1" />);
    expect(storedProps?.selections).toEqual(["run-1"]);
  });

  it("passes an empty selections array when nothing is selected", () => {
    render(<LineageCanvasView {...defaultProps} selectedRunId={null} />);
    expect(storedProps?.selections).toEqual([]);
  });
});

describe("LineageCanvasView — click wiring", () => {
  it("calls onSelectRun with the clicked node's id", () => {
    const onSelectRun = vi.fn();
    render(<LineageCanvasView {...defaultProps} onSelectRun={onSelectRun} />);
    storedProps?.onNodeClick?.({ id: "run-1" });
    expect(onSelectRun).toHaveBeenCalledWith("run-1");
  });

  it("does NOT call onSelectRun when the synthetic root node is clicked", () => {
    const onSelectRun = vi.fn();
    render(<LineageCanvasView {...defaultProps} onSelectRun={onSelectRun} />);
    storedProps?.onNodeClick?.({ id: "__lineage_root__" });
    expect(onSelectRun).not.toHaveBeenCalled();
  });

  it("calls onClearSelection on a canvas click", () => {
    const onClearSelection = vi.fn();
    render(
      <LineageCanvasView
        {...defaultProps}
        onClearSelection={onClearSelection}
      />,
    );
    storedProps?.onCanvasClick?.();
    expect(onClearSelection).toHaveBeenCalled();
  });
});

describe("LineageCanvasView — onApiReady via ref callback", () => {
  it("calls onApiReady with a fit/zoomIn/zoomOut/reset api when the ref mounts", () => {
    const onApiReady = vi.fn();
    render(<LineageCanvasView {...defaultProps} onApiReady={onApiReady} />);

    const fakeRef = {
      fitNodesInView: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      resetControls: vi.fn(),
    };
    act(() => {
      storedRefCallback?.(fakeRef);
    });

    expect(onApiReady).toHaveBeenCalledWith(
      expect.objectContaining({
        fit: expect.any(Function),
        zoomIn: expect.any(Function),
        zoomOut: expect.any(Function),
        reset: expect.any(Function),
      }),
    );
  });

  it("fit() delegates to ref.fitNodesInView()", () => {
    const onApiReady = vi.fn();
    render(<LineageCanvasView {...defaultProps} onApiReady={onApiReady} />);
    const fakeRef = {
      fitNodesInView: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      resetControls: vi.fn(),
    };
    act(() => {
      storedRefCallback?.(fakeRef);
    });
    const api = onApiReady.mock.calls[0]?.[0];
    api?.fit();
    expect(fakeRef.fitNodesInView).toHaveBeenCalled();
  });

  it("calls onApiReady(null) when the ref callback fires with null (unmount)", () => {
    const onApiReady = vi.fn();
    render(<LineageCanvasView {...defaultProps} onApiReady={onApiReady} />);
    act(() => {
      storedRefCallback?.({
        fitNodesInView: vi.fn(),
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        resetControls: vi.fn(),
      });
      storedRefCallback?.(null);
    });
    expect(onApiReady).toHaveBeenLastCalledWith(null);
  });
});
