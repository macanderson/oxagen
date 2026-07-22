// @vitest-environment jsdom
/**
 * lineage-explorer.test.tsx — orchestrator tests for the fleet-lineage
 * explorer. The WebGL canvas is mocked (mirrors graph-explorer.test.tsx) so
 * tests can inspect exactly what props it receives and drive selection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
  act,
} from "@testing-library/react";
import type {
  LineageNodeDto,
  LineageQueryOutput,
} from "@oxagen/oxagen/contracts/lineage.query";

const canvasProps: { current: Record<string, unknown> | null } = {
  current: null,
};

vi.mock("next/dynamic", () => ({
  default: () =>
    function MockLineageCanvas(props: Record<string, unknown>) {
      canvasProps.current = props;
      return <div data-testid="mock-lineage-canvas" />;
    },
}));

import { LineageExplorer } from "./lineage-explorer";

beforeEach(() => {
  canvasProps.current = null;
});
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
    spend: { costUsd: 0.5, inputTokens: 10, outputTokens: 5, llmCalls: 1 },
    delegationViolation: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function baseData(
  overrides: Partial<LineageQueryOutput> = {},
): LineageQueryOutput {
  return {
    dispatchId: "sfo_abc123",
    rootStatus: "completed",
    totalChildren: 1,
    completedChildren: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    nodes: [node({ runId: "run-1" })],
    nodeCount: 1,
    truncated: false,
    maxDepthReached: false,
    ...overrides,
  };
}

describe("LineageExplorer", () => {
  it("renders the root dispatch summary (status, children, node count, spend)", () => {
    render(
      <LineageExplorer
        data={baseData()}
        pickerHref="/acme/ws/automations/lineage"
      />,
    );
    expect(screen.getByTestId("root-status-badge")).toHaveTextContent(
      "completed",
    );
    expect(screen.getByText("1/1 children")).toBeInTheDocument();
    expect(screen.getByText("1 runs")).toBeInTheDocument();
    expect(screen.getByTestId("total-spend")).toHaveTextContent("$0.50");
  });

  it("does not show the truncated/max-depth/violation banners when everything is clean", () => {
    render(
      <LineageExplorer
        data={baseData()}
        pickerHref="/acme/ws/automations/lineage"
      />,
    );
    expect(screen.queryByTestId("truncated-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("max-depth-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("violation-banner")).not.toBeInTheDocument();
  });

  it("shows the truncated banner honestly when data.truncated is true", () => {
    render(
      <LineageExplorer
        data={baseData({ truncated: true })}
        pickerHref="/acme/ws/automations/lineage"
      />,
    );
    expect(screen.getByTestId("truncated-banner")).toBeInTheDocument();
  });

  it("shows the max-depth banner honestly when data.maxDepthReached is true", () => {
    render(
      <LineageExplorer
        data={baseData({ maxDepthReached: true })}
        pickerHref="/acme/ws/automations/lineage"
      />,
    );
    expect(screen.getByTestId("max-depth-banner")).toBeInTheDocument();
  });

  it("shows an unmistakable violation banner citing every violating run by human label", () => {
    const violating = node({
      runId: "bad-run",
      principal: { id: "p9", kind: "agent", displayName: "Rogue Agent" },
      delegationViolation: { ruleId: "authz_denied", message: "denied" },
    });
    render(
      <LineageExplorer
        data={baseData({ nodes: [violating], nodeCount: 1 })}
        pickerHref="/acme/ws/automations/lineage"
      />,
    );
    const banner = screen.getByTestId("violation-banner");
    expect(banner).toBeInTheDocument();
    expect(
      within(banner).getByText(/1 run hit an authorization/i),
    ).toBeInTheDocument();
    expect(
      within(banner).getByText("search_web · Rogue Agent"),
    ).toBeInTheDocument();
  });

  it("passes the flat node list and dispatchId through to the canvas", () => {
    const data = baseData();
    render(
      <LineageExplorer data={data} pickerHref="/acme/ws/automations/lineage" />,
    );
    expect(canvasProps.current?.nodes).toEqual(data.nodes);
    expect(canvasProps.current?.dispatchId).toBe("sfo_abc123");
  });

  it("selecting a row in the list updates the canvas's selectedRunId", () => {
    render(
      <LineageExplorer
        data={baseData()}
        pickerHref="/acme/ws/automations/lineage"
      />,
    );
    expect(canvasProps.current?.selectedRunId).toBeNull();
    fireEvent.click(screen.getByTestId("lineage-row-run-1"));
    expect(canvasProps.current?.selectedRunId).toBe("run-1");
  });

  it("selecting a node from the canvas (onSelectRun) is reflected back into the list selection", () => {
    render(
      <LineageExplorer
        data={baseData()}
        pickerHref="/acme/ws/automations/lineage"
      />,
    );
    const onSelectRun = canvasProps.current?.onSelectRun as (
      id: string,
    ) => void;
    act(() => {
      onSelectRun("run-1");
    });
    const row = screen
      .getByTestId("lineage-row-run-1")
      .closest('[role="treeitem"]');
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  it("renders a link back to the dispatch picker", () => {
    render(
      <LineageExplorer
        data={baseData()}
        pickerHref="/acme/ws/automations/lineage"
      />,
    );
    const link = screen.getByRole("link", { name: /change dispatch/i });
    expect(link).toHaveAttribute("href", "/acme/ws/automations/lineage");
  });
});
