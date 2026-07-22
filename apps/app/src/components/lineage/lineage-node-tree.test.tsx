// @vitest-environment jsdom
/**
 * lineage-node-tree.test.tsx — render tests for the indented fleet-run list.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LineageNodeTree } from "./lineage-node-tree";
import { buildLineageTree } from "@/lib/lineage/tree";
import type { LineageNodeDto } from "@oxagen/oxagen/contracts/lineage.query";

afterEach(cleanup);

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
    spend: { costUsd: 0.42, inputTokens: 10, outputTokens: 5, llmCalls: 1 },
    delegationViolation: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

describe("LineageNodeTree", () => {
  it("shows an explanatory empty message for an empty tree", () => {
    render(
      <LineageNodeTree tree={[]} selectedRunId={null} onSelect={vi.fn()} />,
    );
    expect(
      screen.getByText(/no runs in this dispatch yet/i),
    ).toBeInTheDocument();
  });

  it("renders each node via its human label (capability · principal), never the raw runId", () => {
    const tree = buildLineageTree([
      node({
        runId: "sar_do_not_show_me",
        capabilityName: "search_web",
        principal: { id: "p1", kind: "agent", displayName: "Jane Doe" },
      }),
    ]);
    render(
      <LineageNodeTree tree={tree} selectedRunId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("search_web · Jane Doe")).toBeInTheDocument();
    expect(screen.queryByText(/sar_do_not_show_me/)).not.toBeInTheDocument();
  });

  it("renders nested children under their parent row", () => {
    const root = node({ runId: "root", capabilityName: "dispatch_subagent" });
    const child = node({
      runId: "child",
      parentRunId: "root",
      depth: 1,
      capabilityName: "summarize",
    });
    const tree = buildLineageTree([root, child]);
    render(
      <LineageNodeTree tree={tree} selectedRunId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByTestId("lineage-row-root")).toBeInTheDocument();
    expect(screen.getByTestId("lineage-row-child")).toBeInTheDocument();
  });

  it("flags a delegation-violation node with a visible violation badge", () => {
    const violating = node({
      runId: "bad",
      delegationViolation: { ruleId: "authz_denied", message: "denied" },
    });
    const tree = buildLineageTree([violating]);
    render(
      <LineageNodeTree tree={tree} selectedRunId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByTestId("violation-flag-bad")).toBeInTheDocument();
    expect(screen.getByText(/delegation violation/i)).toBeInTheDocument();
  });

  it("does not render a violation badge for a clean node", () => {
    const clean = node({ runId: "ok" });
    const tree = buildLineageTree([clean]);
    render(
      <LineageNodeTree tree={tree} selectedRunId={null} onSelect={vi.fn()} />,
    );
    expect(screen.queryByTestId("violation-flag-ok")).not.toBeInTheDocument();
  });

  it("calls onSelect with the run's id when a row is clicked", () => {
    const onSelect = vi.fn();
    const tree = buildLineageTree([node({ runId: "run-1" })]);
    render(
      <LineageNodeTree tree={tree} selectedRunId={null} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId("lineage-row-run-1"));
    expect(onSelect).toHaveBeenCalledWith("run-1");
  });

  it("calls onSelect on Enter keydown (keyboard accessible)", () => {
    const onSelect = vi.fn();
    const tree = buildLineageTree([node({ runId: "run-1" })]);
    render(
      <LineageNodeTree tree={tree} selectedRunId={null} onSelect={onSelect} />,
    );
    fireEvent.keyDown(screen.getByTestId("lineage-row-run-1"), {
      key: "Enter",
    });
    expect(onSelect).toHaveBeenCalledWith("run-1");
  });

  it("shows the formatted spend for a node", () => {
    const tree = buildLineageTree([
      node({
        runId: "run-1",
        spend: { costUsd: 1.5, inputTokens: 0, outputTokens: 0, llmCalls: 1 },
      }),
    ]);
    render(
      <LineageNodeTree tree={tree} selectedRunId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("$1.50")).toBeInTheDocument();
  });

  it("marks the selected row with aria-selected", () => {
    const tree = buildLineageTree([node({ runId: "run-1" })]);
    render(
      <LineageNodeTree tree={tree} selectedRunId="run-1" onSelect={vi.fn()} />,
    );
    const treeitem = screen
      .getByTestId("lineage-row-run-1")
      .closest('[role="treeitem"]');
    expect(treeitem).toHaveAttribute("aria-selected", "true");
  });
});
