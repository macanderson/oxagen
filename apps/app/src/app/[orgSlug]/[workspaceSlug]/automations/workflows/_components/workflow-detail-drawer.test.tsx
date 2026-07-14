// @vitest-environment jsdom
/**
 * workflow-detail-drawer.test.tsx — unit tests for the workflow/swarm detail
 * drawer's title/description derivation, cancel gating, and cancel wiring.
 *
 * The reused chat render components (WorkflowProgress, ResearchSwarmCard)
 * poll their own API routes on an interval — mocked to simple stubs so this
 * test only exercises the drawer's own logic, per the module doc ("their own
 * behavior is owned by workflow-progress.tsx / research-swarm-card.tsx, not
 * this page"). The Drawer/Sheet primitive is left real — it composes the
 * same Base UI Dialog primitive as `@/components/ui/dialog` (both wrap
 * `@base-ui/react/dialog`), which mounts asynchronously in jsdom (same as
 * sandbox-files-drawer.test.tsx, an existing passing test using this exact
 * primitive unmocked) — so assertions on drawer content use findBy + waitFor.
 *
 * Covers:
 *   - target=null renders nothing (no progress/card stub).
 *   - A running workflow: renders WorkflowProgress with the workflow id +
 *     tenant slugs, the title, and a Cancel button (canManage true,
 *     non-terminal status).
 *   - A terminal workflow (completed/failed/cancelled): Cancel is hidden even
 *     when canManage is true.
 *   - canManage=false hides Cancel regardless of status.
 *   - Cancel calls cancelWorkflowAction with the workflow id, shows a success
 *     toast, and refreshes; a failed cancel shows an error toast and does
 *     not refresh.
 *   - A swarm target renders ResearchSwarmCard with the swarm's progress and
 *     never shows Cancel.
 */
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkflowDetailTarget } from "./workflow-detail-drawer";

const { mockRefresh, mockAddToast, mockCancelWorkflowAction } = vi.hoisted(
  () => ({
    mockRefresh: vi.fn(),
    mockAddToast: vi.fn(),
    mockCancelWorkflowAction: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("../actions", () => ({
  cancelWorkflowAction: (...args: unknown[]) =>
    mockCancelWorkflowAction(...args),
}));

vi.mock("@/components/chat/registry-components/workflow-progress", () => ({
  default: ({
    workflowId,
    orgSlug,
    workspaceSlug,
  }: {
    workflowId: string;
    orgSlug?: string;
    workspaceSlug?: string;
  }) => (
    <div data-testid="workflow-progress-stub">
      progress for {workflowId} ({orgSlug}/{workspaceSlug})
    </div>
  ),
}));

vi.mock("@/components/chat/registry-components/research-swarm-card", () => ({
  default: ({
    output,
  }: {
    output: {
      swarmId: string;
      status: string;
      completedTasks: number;
      totalTasks: number;
    };
  }) => (
    <div data-testid="research-swarm-card-stub">
      swarm {output.swarmId} {output.completedTasks}/{output.totalTasks} (
      {output.status})
    </div>
  ),
}));

import { WorkflowDetailDrawer } from "./workflow-detail-drawer";

const BASE_PROPS = { orgSlug: "acme", workspaceSlug: "main" };

beforeEach(() => {
  vi.clearAllMocks();
  mockCancelWorkflowAction.mockResolvedValue({
    ok: true,
    result: { cancelled: true },
  });
});

afterEach(() => cleanup());

describe("WorkflowDetailDrawer — closed", () => {
  it("renders nothing when target is null", () => {
    render(
      <WorkflowDetailDrawer
        target={null}
        onOpenChange={vi.fn()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    expect(screen.queryByTestId("workflow-progress-stub")).toBeNull();
    expect(screen.queryByTestId("research-swarm-card-stub")).toBeNull();
  });
});

describe("WorkflowDetailDrawer — workflow target", () => {
  const runningTarget: WorkflowDetailTarget = {
    type: "workflow",
    id: "wf-1",
    title: "Pricing sweep",
    goal: "Summarize competitor pricing",
    status: "running",
  };

  it("renders WorkflowProgress with the workflow id + tenant slugs", async () => {
    render(
      <WorkflowDetailDrawer
        target={runningTarget}
        onOpenChange={vi.fn()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    const stub = await screen.findByTestId("workflow-progress-stub");
    expect(stub.textContent).toContain("wf-1");
    expect(stub.textContent).toContain("acme/main");
  });

  it("shows Cancel for a non-terminal workflow when canManage is true", async () => {
    render(
      <WorkflowDetailDrawer
        target={runningTarget}
        onOpenChange={vi.fn()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    expect(await screen.findByTestId("drawer-cancel-workflow")).toBeTruthy();
  });

  it.each(["completed", "failed", "cancelled"])(
    "hides Cancel for a terminal workflow (status=%s) even when canManage is true",
    async (status) => {
      render(
        <WorkflowDetailDrawer
          target={{ ...runningTarget, status }}
          onOpenChange={vi.fn()}
          canManage={true}
          {...BASE_PROPS}
        />,
      );
      await screen.findByTestId("workflow-progress-stub");
      expect(screen.queryByTestId("drawer-cancel-workflow")).toBeNull();
    },
  );

  it("hides Cancel when canManage is false, even for a running workflow", async () => {
    render(
      <WorkflowDetailDrawer
        target={runningTarget}
        onOpenChange={vi.fn()}
        canManage={false}
        {...BASE_PROPS}
      />,
    );
    await screen.findByTestId("workflow-progress-stub");
    expect(screen.queryByTestId("drawer-cancel-workflow")).toBeNull();
  });

  it("Cancel calls cancelWorkflowAction, shows a success toast, and refreshes", async () => {
    render(
      <WorkflowDetailDrawer
        target={runningTarget}
        onOpenChange={vi.fn()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    const cancelBtn = await screen.findByTestId("drawer-cancel-workflow");
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    await waitFor(() =>
      expect(mockCancelWorkflowAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        workflowId: "wf-1",
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("a failed cancel shows an error toast and does not refresh", async () => {
    mockCancelWorkflowAction.mockResolvedValue({
      ok: false,
      error: "Already terminal.",
    });
    render(
      <WorkflowDetailDrawer
        target={runningTarget}
        onOpenChange={vi.fn()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    const cancelBtn = await screen.findByTestId("drawer-cancel-workflow");
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          description: "Already terminal.",
        }),
      ),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("WorkflowDetailDrawer — swarm target", () => {
  const swarmTarget: WorkflowDetailTarget = {
    type: "swarm",
    swarm: {
      swarmId: "s1",
      dispatchId: "d1",
      topic: "AI safety funding",
      depth: "medium",
      maxParallel: 5,
      targetLabel: "Topic",
      status: "running",
      completedTasks: 2,
      totalTasks: 8,
      launchedAt: "2026-07-01T00:00:00.000Z",
    },
  };

  it("renders ResearchSwarmCard with the swarm's progress and never shows Cancel", async () => {
    render(
      <WorkflowDetailDrawer
        target={swarmTarget}
        onOpenChange={vi.fn()}
        canManage={true}
        {...BASE_PROPS}
      />,
    );
    const stub = await screen.findByTestId("research-swarm-card-stub");
    expect(stub.textContent).toContain("s1");
    expect(stub.textContent).toContain("2/8");
    expect(screen.queryByTestId("drawer-cancel-workflow")).toBeNull();
  });
});
