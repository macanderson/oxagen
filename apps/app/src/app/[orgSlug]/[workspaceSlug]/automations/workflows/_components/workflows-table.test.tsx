// @vitest-environment jsdom
/**
 * workflows-table.test.tsx — unit tests for the Workflows & swarms table.
 *
 * Base UI popover primitives (Menu, SegmentedControl) are mocked to plain
 * controlled elements — same convention as delete-source-dialog.test.tsx and
 * launch-workflow-dialog.test.tsx — so tests exercise the real gating /
 * dispatch logic without depending on Base UI portals in jsdom. The detail
 * drawer (which mounts the real reused chat components and polls) is mocked
 * to a stub that just reports whether a target was set — its own behavior is
 * owned by workflow-progress.tsx / research-swarm-card.tsx (chat surface),
 * not this page.
 *
 * Covers:
 *   - Combined empty state when there are no workflows and no swarms.
 *   - Enriched row shows progress % and sub-task count.
 *   - Unenriched row shows "—" for progress/sub-tasks (contract-gap fallback).
 *   - Cancel action hidden when canManage=false or the run is terminal.
 *   - Cancel action calls cancelWorkflowAction with the row's execution id.
 *   - Clicking a row opens the detail drawer.
 *   - Swarms tab renders client-session-tracked swarm rows.
 */
import * as React from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkflowRunRow } from "@/lib/automations/workflows";
import type { SwarmSessionRecord } from "./swarm-session-store";

const { mockAddToast, mockCancelAction, viewState, swarmState } = vi.hoisted(
  () => ({
    mockAddToast: vi.fn(),
    mockCancelAction: vi.fn(),
    viewState: { onChange: null as ((v: string) => void) | null },
    swarmState: { swarms: [] as SwarmSessionRecord[] },
  }),
);

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("../actions", () => ({
  cancelWorkflowAction: (...args: unknown[]) => mockCancelAction(...args),
}));

vi.mock("./swarm-session-store", () => ({
  useSwarmSessionStore: () => ({
    swarms: swarmState.swarms,
    addSwarm: vi.fn(),
    updateSwarm: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("./workflow-detail-drawer", () => ({
  WorkflowDetailDrawer: ({ target }: { target: unknown }) =>
    target ? <div data-testid="detail-open" /> : null,
}));

// Menu → always-visible content (no trigger click needed to reach items).
vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MenuItem: ({
    children,
    onClick,
    ...rest
  }: { children: React.ReactNode; onClick?: () => void } & Record<
    string,
    unknown
  >) => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

// SegmentedControl → controlled mock (same pattern as the Tabs mock in
// launch-workflow-dialog.test.tsx).
vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange: (v: string) => void;
  }) => {
    viewState.onChange = onValueChange;
    return <div data-testid="segmented-control">{children}</div>;
  },
  SegmentedControlItem: ({
    children,
    value,
    ...rest
  }: { children: React.ReactNode; value: string } & Record<
    string,
    unknown
  >) => (
    <button type="button" onClick={() => viewState.onChange?.(value)} {...rest}>
      {children}
    </button>
  ),
}));

import { WorkflowsTable } from "./workflows-table";

function row(overrides: Partial<WorkflowRunRow>): WorkflowRunRow {
  return {
    executionId: "wf-default",
    status: "completed",
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:05:00.000Z",
    latencyMs: 300_000,
    estimatedCostUsd: "0.0500",
    createdAt: "2026-07-01T00:00:00.000Z",
    enriched: false,
    ...overrides,
  };
}

const BASE_PROPS = {
  workflows: [] as WorkflowRunRow[],
  canManage: true,
  orgSlug: "acme",
  workspaceSlug: "main",
};

beforeEach(() => {
  vi.clearAllMocks();
  swarmState.swarms = [];
  viewState.onChange = null;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  mockCancelAction.mockResolvedValue({ ok: true, result: { cancelled: true } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkflowsTable — empty state", () => {
  it("renders the combined empty state when there are no workflows and no swarms", () => {
    render(<WorkflowsTable {...BASE_PROPS} />);
    expect(screen.getByText("No workflows or swarms yet")).toBeTruthy();
  });
});

describe("WorkflowsTable — Workflows tab", () => {
  it("shows progress % and sub-task count for an enriched row", () => {
    render(
      <WorkflowsTable
        {...BASE_PROPS}
        workflows={[
          row({
            executionId: "wf-1",
            title: "Pricing sweep",
            status: "running",
            enriched: true,
            totalTasks: 10,
            completedTasks: 4,
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("workflow-row-wf-1").textContent).toBe(
      "Pricing sweep",
    );
    const cells =
      screen.getByTestId("workflow-row-wf-1").closest("tr")?.textContent ?? "";
    expect(cells).toContain("40%");
    expect(cells).toContain("10");
  });

  it("shows a dash for progress and sub-tasks on an unenriched row", () => {
    render(
      <WorkflowsTable
        {...BASE_PROPS}
        workflows={[
          row({ executionId: "wf-2", status: "completed", enriched: false }),
        ]}
      />,
    );
    const cells =
      screen.getByTestId("workflow-row-wf-2").closest("tr")?.textContent ?? "";
    expect(cells).toContain("—");
  });

  it("hides Cancel when canManage is false", () => {
    render(
      <WorkflowsTable
        {...BASE_PROPS}
        canManage={false}
        workflows={[
          row({ executionId: "wf-3", status: "running", enriched: true }),
        ]}
      />,
    );
    expect(screen.queryByTestId("cancel-wf-3")).toBeNull();
  });

  it("hides Cancel for a terminal run even when canManage is true", () => {
    render(
      <WorkflowsTable
        {...BASE_PROPS}
        canManage={true}
        workflows={[
          row({ executionId: "wf-4", status: "completed", enriched: true }),
        ]}
      />,
    );
    expect(screen.queryByTestId("cancel-wf-4")).toBeNull();
  });

  it("Cancel calls cancelWorkflowAction with the row's execution id", async () => {
    render(
      <WorkflowsTable
        {...BASE_PROPS}
        canManage={true}
        workflows={[
          row({ executionId: "wf-5", status: "running", enriched: true }),
        ]}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("cancel-wf-5"));
    });
    await waitFor(() =>
      expect(mockCancelAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        workflowId: "wf-5",
      }),
    );
  });

  it("clicking a row opens the detail drawer", async () => {
    render(
      <WorkflowsTable
        {...BASE_PROPS}
        workflows={[
          row({ executionId: "wf-6", status: "completed", enriched: true }),
        ]}
      />,
    );
    expect(screen.queryByTestId("detail-open")).toBeNull();
    fireEvent.click(screen.getByTestId("workflow-row-wf-6"));
    await waitFor(() => expect(screen.getByTestId("detail-open")).toBeTruthy());
  });
});

describe("WorkflowsTable — Swarms tab", () => {
  it("renders client-session-tracked swarm rows", () => {
    swarmState.swarms = [
      {
        swarmId: "s1",
        dispatchId: "d1",
        topic: "AI safety funding",
        depth: "deep",
        maxParallel: 10,
        targetLabel: "Topic",
        status: "running",
        completedTasks: 2,
        totalTasks: 8,
        launchedAt: "2026-07-01T00:00:00.000Z",
      },
    ];
    render(<WorkflowsTable {...BASE_PROPS} workflows={[]} />);
    fireEvent.click(screen.getByTestId("view-swarms"));
    expect(screen.getByTestId("swarm-row-s1").textContent).toBe(
      "AI safety funding",
    );
    const cells =
      screen.getByTestId("swarm-row-s1").closest("tr")?.textContent ?? "";
    expect(cells).toContain("2 / 8");
  });
});
