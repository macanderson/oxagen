// @vitest-environment jsdom
/**
 * workflow-progress.test.tsx
 *
 * Render + interaction tests for WorkflowProgress:
 *   - Renders loading skeleton when fetch is pending
 *   - Renders error state when fetch fails
 *   - Renders workflow data when fetch succeeds
 *   - Shows progress bar and metrics
 *   - Shows Cancel button when workflow is running
 *   - Shows Download link when workflow is completed
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

afterEach(cleanup);

vi.mock("lucide-react", () => ({
  CheckCircle2: () => <span data-testid="icon-check" />,
  XCircle: () => <span data-testid="icon-xcircle" />,
  Loader2: () => <span data-testid="icon-loader" />,
  CircleDot: () => <span data-testid="icon-circledot" />,
  Download: () => <span data-testid="icon-download" />,
  X: () => <span data-testid="icon-x" />,
  BarChart3: () => <span data-testid="icon-barchart" />,
  Clock: () => <span data-testid="icon-clock" />,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Minimal WorkflowRunSnapshot shape
const RUNNING_WORKFLOW = {
  id: "wf_123",
  title: "Data Analysis Pipeline",
  goal: "Analyze customer data",
  status: "running" as const,
  totalTasks: 10,
  completedTasks: 3,
  failedTasks: 0,
  startedAt: new Date(Date.now() - 60000).toISOString(),
  completedAt: null,
  resultUrl: null,
  outputFormat: "json" as const,
};

const COMPLETED_WORKFLOW = {
  ...RUNNING_WORKFLOW,
  status: "completed" as const,
  completedTasks: 10,
  completedAt: new Date().toISOString(),
  resultUrl: "/api/v1/assets/result_abc",
};

const TASKS = [
  {
    id: "task_1",
    taskIndex: 0,
    title: "Load data",
    status: "completed" as const,
    startedAt: new Date(Date.now() - 50000).toISOString(),
    completedAt: new Date(Date.now() - 40000).toISOString(),
  },
  {
    id: "task_2",
    taskIndex: 1,
    title: "Clean data",
    status: "running" as const,
    startedAt: new Date(Date.now() - 30000).toISOString(),
    completedAt: null,
  },
];

describe("WorkflowProgress", () => {
  it("renders loading skeleton when fetch is pending", async () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    const { default: WorkflowProgress } = await import("./workflow-progress");
    render(<WorkflowProgress workflowId="wf_123" />);
    // Loading skeleton has animate-pulse class
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders error state when fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load workflow/)).toBeInTheDocument();
    });
  });

  it("renders workflow title after successful fetch", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      expect(screen.getByText("Data Analysis Pipeline")).toBeInTheDocument();
    });
  });

  it("renders workflow goal after successful fetch", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      expect(screen.getByText("Analyze customer data")).toBeInTheDocument();
    });
  });

  it("renders 'Running' status badge for running workflow", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      expect(screen.getByText("Running")).toBeInTheDocument();
    });
  });

  it("shows progress bar with aria-valuenow", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      const progressbar = screen.getByRole("progressbar");
      expect(progressbar).toBeInTheDocument();
      // 3/10 = 30%
      expect(progressbar).toHaveAttribute("aria-valuenow", "30");
    });
  });

  it("shows Cancel button for running workflow", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
    });
  });

  it("shows Download link for completed workflow", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: COMPLETED_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      // The link uses aria-label "Download results as JSON"
      expect(screen.getByRole("link", { name: /Download results as JSON/i })).toBeInTheDocument();
    });
  });

  it("shows task cells when tasks are present", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });
  });
});
