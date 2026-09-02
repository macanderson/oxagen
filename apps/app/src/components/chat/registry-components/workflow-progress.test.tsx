// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
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

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
    XCircle: vi.fn(() => <span data-testid="icon-xcircle" />),
    Loader2: vi.fn(() => <span data-testid="icon-loader" />),
    CircleDot: vi.fn(() => <span data-testid="icon-circledot" />),
    Download: vi.fn(() => <span data-testid="icon-download" />),
    X: vi.fn(() => <span data-testid="icon-x" />),
    BarChart3: vi.fn(() => <span data-testid="icon-barchart" />),
    Clock: vi.fn(() => <span data-testid="icon-clock" />),
  };
});

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
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    // Loading skeleton has animate-pulse class
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders error state when fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
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
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
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
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
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
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
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
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
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
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Cancel/ }),
      ).toBeInTheDocument();
    });
  });

  it("shows Download link for completed workflow", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ workflow: COMPLETED_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await waitFor(() => {
      // The link uses aria-label "Download results as JSON"
      expect(
        screen.getByRole("link", { name: /Download results as JSON/i }),
      ).toBeInTheDocument();
    });
  });

  it("polls the org+workspace-scoped, plural workflows URL (regression: 404 from slug-less /api/v1/workflow/:id)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
    });
    global.fetch = fetchMock;
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Data Analysis Pipeline")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/acme/main/workflows/wf_123",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("does not fetch and surfaces missing-context error when org/workspace slugs are absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(<WorkflowProgress workflowId="wf_123" />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load workflow/)).toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows task cells when tasks are present", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
    });
    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });
  });
});

// ── Cancel error surfacing ────────────────────────────────────────────────────
// Tests that a failed DELETE /api/v1/:org/:ws/workflows/:id call surfaces a visible
// error to the user instead of being silently swallowed.

import { fireEvent } from "@testing-library/react";

describe("WorkflowProgress — cancel error surfacing", () => {
  it("shows cancel-error alert when DELETE returns non-2xx", async () => {
    global.fetch = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
          });
        }
        // DELETE
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "Internal server error" }),
        });
      });

    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Cancel/ }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

    await waitFor(() => {
      expect(screen.getByTestId("cancel-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("cancel-error")).toHaveTextContent(
      /cancel failed/i,
    );
    expect(screen.getByTestId("cancel-error")).toHaveTextContent(
      /still running/i,
    );
  });

  it("shows cancel-error alert when DELETE throws a network error", async () => {
    global.fetch = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
          });
        }
        return Promise.reject(new Error("ERR_NETWORK"));
      });

    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Cancel/ }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

    await waitFor(() => {
      expect(screen.getByTestId("cancel-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("cancel-error")).toHaveTextContent("ERR_NETWORK");
  });

  it("does NOT show cancel-error when DELETE succeeds", async () => {
    global.fetch = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => {
        if (!init?.method || init.method === "GET") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ workflow: RUNNING_WORKFLOW, tasks: TASKS }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cancelled: true }),
        });
      });

    const WorkflowProgress = (await import("./workflow-progress")).default;
    render(
      <WorkflowProgress
        workflowId="wf_123"
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Cancel/ }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

    // Give time for the async handler to settle
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.queryByTestId("cancel-error")).not.toBeInTheDocument();
  });
});
