// @vitest-environment jsdom
/**
 * launch-workflow-dialog.test.tsx — unit tests for the launch form validation
 * and submit wiring (Workflow + Swarm tabs).
 *
 * Base UI primitives (Dialog, Tabs, Select) are mocked to plain controlled
 * elements — same convention as delete-source-dialog.test.tsx — so the test
 * exercises real component state/validation logic without depending on
 * Base UI portals/floating-ui positioning in jsdom (untested territory
 * elsewhere in this codebase; the interactive Base UI chrome itself is
 * covered by the e2e spec).
 *
 * Covers:
 *   - Workflow tab renders by default with the goal field.
 *   - Empty goal → inline "Goal is required." error, no action call.
 *   - Over-max goal (>2000 chars) → inline length error, no action call.
 *   - Valid goal → runWorkflowAction called with contract-valid input,
 *     dialog closes, router.refresh() called.
 *   - runWorkflowAction ok:false → the capability's error renders inline.
 *   - Switching to the Swarm tab renders the topic field.
 *   - Empty topic → inline "Topic is required." error, no action call.
 *   - Valid topic → startResearchSwarmAction called with contract-valid
 *     input and onSwarmLaunched receives the launched record.
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

const {
  mockAddToast,
  mockRefresh,
  mockRunWorkflowAction,
  mockStartResearchSwarmAction,
  tabState,
} = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockRefresh: vi.fn(),
  mockRunWorkflowAction: vi.fn(),
  mockStartResearchSwarmAction: vi.fn(),
  tabState: {
    value: "workflow",
    onChange: null as ((v: string) => void) | null,
  },
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("../actions", () => ({
  runWorkflowAction: (...args: unknown[]) => mockRunWorkflowAction(...args),
  startResearchSwarmAction: (...args: unknown[]) =>
    mockStartResearchSwarmAction(...args),
}));

// Dialog primitives → plain divs (skip Base UI portals/animation in jsdom).
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogPopup: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...rest}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Tabs → controlled mock that actually switches, so tab-specific fields are
// reachable via a real click (mirrors the RadioGroup pattern used elsewhere).
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => {
    tabState.value = value;
    tabState.onChange = onValueChange;
    return (
      <div data-testid="tabs" data-value={value}>
        {children}
      </div>
    );
  },
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TabsTab: ({
    children,
    value,
    ...rest
  }: { children: React.ReactNode; value: string } & Record<
    string,
    unknown
  >) => (
    <button type="button" onClick={() => tabState.onChange?.(value)} {...rest}>
      {children}
    </button>
  ),
  TabsPanel: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => (value === tabState.value ? <div>{children}</div> : null),
}));

// Select → inert (only default values are exercised by these tests).
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { LaunchWorkflowDialog } from "./launch-workflow-dialog";

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  orgSlug: "acme",
  workspaceSlug: "main",
};

beforeEach(() => {
  vi.clearAllMocks();
  tabState.value = "workflow";
  tabState.onChange = null;
  mockRunWorkflowAction.mockResolvedValue({
    ok: true,
    workflow: { workflowId: "wf-1", publicId: "wfr_1", status: "planning" },
  });
  mockStartResearchSwarmAction.mockResolvedValue({
    ok: true,
    swarm: {
      swarmId: "s1",
      dispatchId: "d1",
      status: "running",
      estimatedTasks: 8,
    },
  });
});

afterEach(() => cleanup());

describe("LaunchWorkflowDialog — Workflow tab", () => {
  it("renders the goal field by default", () => {
    render(<LaunchWorkflowDialog {...BASE_PROPS} />);
    expect(screen.getByTestId("workflow-goal")).toBeTruthy();
  });

  it("shows an inline error for an empty goal and never calls the action", async () => {
    render(<LaunchWorkflowDialog {...BASE_PROPS} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("launch-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("launch-error").textContent).toBe(
        "Goal is required.",
      );
    });
    expect(mockRunWorkflowAction).not.toHaveBeenCalled();
  });

  it("shows an inline error when the goal exceeds 2000 characters", async () => {
    render(<LaunchWorkflowDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("workflow-goal"), {
      target: { value: "a".repeat(2001) },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("launch-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("launch-error").textContent).toContain(
        "2000 characters or fewer",
      );
    });
    expect(mockRunWorkflowAction).not.toHaveBeenCalled();
  });

  it("submits contract-valid input and refreshes on success", async () => {
    render(<LaunchWorkflowDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("workflow-goal"), {
      target: { value: "Summarize 40 competitor pricing pages" },
    });
    fireEvent.change(screen.getByTestId("workflow-title"), {
      target: { value: "Pricing sweep" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("launch-submit"));
    });
    await waitFor(() => expect(mockRunWorkflowAction).toHaveBeenCalled());
    expect(mockRunWorkflowAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      goal: "Summarize 40 competitor pricing pages",
      title: "Pricing sweep",
      outputFormat: "json",
      maxParallelism: 50,
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("renders the capability's own error message inline on failure", async () => {
    mockRunWorkflowAction.mockResolvedValue({
      ok: false,
      error:
        "Only workspace owners and admins can launch or cancel workflows and research swarms.",
    });
    render(<LaunchWorkflowDialog {...BASE_PROPS} />);
    fireEvent.change(screen.getByTestId("workflow-goal"), {
      target: { value: "Do the thing" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("launch-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("launch-error").textContent).toContain(
        "Only workspace owners and admins",
      );
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("LaunchWorkflowDialog — Swarm tab", () => {
  function switchToSwarmTab() {
    fireEvent.click(screen.getByTestId("launch-tab-swarm"));
  }

  it("renders the topic field after switching tabs", () => {
    render(<LaunchWorkflowDialog {...BASE_PROPS} />);
    switchToSwarmTab();
    expect(screen.getByTestId("swarm-topic")).toBeTruthy();
  });

  it("shows an inline error for an empty topic and never calls the action", async () => {
    render(<LaunchWorkflowDialog {...BASE_PROPS} />);
    switchToSwarmTab();
    await act(async () => {
      fireEvent.click(screen.getByTestId("launch-submit"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("launch-error").textContent).toBe(
        "Topic is required.",
      );
    });
    expect(mockStartResearchSwarmAction).not.toHaveBeenCalled();
  });

  it("submits contract-valid input and forwards the launched swarm", async () => {
    const onSwarmLaunched = vi.fn();
    render(
      <LaunchWorkflowDialog
        {...BASE_PROPS}
        onSwarmLaunched={onSwarmLaunched}
      />,
    );
    switchToSwarmTab();
    fireEvent.change(screen.getByTestId("swarm-topic"), {
      target: { value: "AI safety funding 2026" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("launch-submit"));
    });
    await waitFor(() =>
      expect(mockStartResearchSwarmAction).toHaveBeenCalled(),
    );
    expect(mockStartResearchSwarmAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      topic: "AI safety funding 2026",
      depth: "medium",
      maxParallel: 5,
      targetLabel: "Topic",
    });
    await waitFor(() =>
      expect(onSwarmLaunched).toHaveBeenCalledWith(
        expect.objectContaining({
          swarmId: "s1",
          status: "running",
          totalTasks: 8,
        }),
      ),
    );
  });
});
