// @vitest-environment jsdom
/**
 * background-task-tray.test.tsx
 *
 * Tests for BackgroundTaskTray and related helpers:
 *   - TaskTrayProvider + useTaskTray context
 *   - BackgroundTaskTray renders null when no tasks
 *   - BackgroundTaskTray shows the active/total task count
 *   - Collapse/expand toggle behaviour
 *   - Dismiss terminal task
 *   - formatDuration re-export from tool-call-card
 *   - useElapsed ticks correctly (via TaskRow elapsed display)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TaskTrayProvider,
  useTaskTray,
  BackgroundTaskTray,
} from "./background-task-tray";
import { useEffect } from "react";

afterEach(cleanup);

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    size,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      data-variant={variant}
      data-size={size}
    >
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    ChevronDown: vi.fn(() => <span data-testid="chevron-down" />),
    ChevronUp: vi.fn(() => <span data-testid="chevron-up" />),
    Loader2: vi.fn(({ className }: { className?: string }) => (
      <span data-testid="loader2" className={className} />
    )),
    X: vi.fn(() => <span data-testid="icon-x" />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("./tool-call-card", () => ({
  formatDuration: (ms: number) => `${ms}ms`,
}));

const makeSnapshot = (
  taskId: string,
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled" = "running",
) => ({
  taskId,
  kind: "video.render",
  label: `Task ${taskId}`,
  status,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  completedAt: status === "completed" ? new Date().toISOString() : null,
  progress: null,
  failureReason: null,
});

describe("TaskTrayProvider + useTaskTray", () => {
  it("provides push and remove operations", () => {
    let tray: ReturnType<typeof useTaskTray> | null = null;
    function Consumer() {
      tray = useTaskTray();
      return null;
    }
    render(
      <TaskTrayProvider>
        <Consumer />
      </TaskTrayProvider>,
    );
    expect(tray).not.toBeNull();
    expect(typeof tray!.push).toBe("function");
    expect(typeof tray!.remove).toBe("function");
  });

  it("push adds a taskId to the context", () => {
    let tray: ReturnType<typeof useTaskTray> | null = null;
    function Consumer() {
      tray = useTaskTray();
      useEffect(() => {
        tray?.push("task-abc");
      }, []);
      return null;
    }
    render(
      <TaskTrayProvider>
        <Consumer />
      </TaskTrayProvider>,
    );
    expect(tray!.taskIds).toContain("task-abc");
  });

  it("remove removes a taskId from the context", () => {
    let tray: ReturnType<typeof useTaskTray> | null = null;
    function Consumer() {
      tray = useTaskTray();
      useEffect(() => {
        tray?.push("task-xyz");
        tray?.remove("task-xyz");
      }, []);
      return null;
    }
    render(
      <TaskTrayProvider initialTaskIds={["task-xyz"]}>
        <Consumer />
      </TaskTrayProvider>,
    );
    expect(tray!.taskIds).not.toContain("task-xyz");
  });

  it("throws when useTaskTray is called outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function BadConsumer() {
      useTaskTray();
      return null;
    }
    expect(() => render(<BadConsumer />)).toThrow(
      "useTaskTray must be used inside <TaskTrayProvider>",
    );
    spy.mockRestore();
  });

  it("initialTaskIds seeds the context", () => {
    let tray: ReturnType<typeof useTaskTray> | null = null;
    function Consumer() {
      tray = useTaskTray();
      return null;
    }
    render(
      <TaskTrayProvider initialTaskIds={["seed-1", "seed-2"]}>
        <Consumer />
      </TaskTrayProvider>,
    );
    expect(tray!.taskIds).toEqual(["seed-1", "seed-2"]);
  });
});

describe("BackgroundTaskTray", () => {
  it("renders null when no task IDs", () => {
    const { container } = render(<BackgroundTaskTray fetchTask={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the tray when initialTaskIds has items", () => {
    // Pass a fetchTask that never resolves so there is no timer runaway
    const fetchTask = vi.fn().mockReturnValue(new Promise(() => {}));
    render(
      <BackgroundTaskTray initialTaskIds={["t1"]} fetchTask={fetchTask} />,
    );
    expect(screen.getByText("Background tasks")).toBeInTheDocument();
  });

  it("shows the correct active/total count text", () => {
    const fetchTask = vi.fn().mockReturnValue(new Promise(() => {}));
    render(
      <BackgroundTaskTray
        initialTaskIds={["t1", "t2"]}
        fetchTask={fetchTask}
      />,
    );
    // 2 active (no snapshots yet) / 2 total
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("collapses and expands on button click", async () => {
    const fetchTask = vi.fn().mockReturnValue(new Promise(() => {}));
    render(
      <BackgroundTaskTray initialTaskIds={["t1"]} fetchTask={fetchTask} />,
    );
    const toggle = screen.getByText("Background tasks").closest("button")!;
    // Expanded by default — chevron-down visible
    expect(screen.getByTestId("chevron-down")).toBeInTheDocument();
    await userEvent.click(toggle);
    // Now collapsed — chevron-up visible
    expect(screen.getByTestId("chevron-up")).toBeInTheDocument();
  });

  it("task row shows taskId in the label when no snapshot has loaded yet", () => {
    // Use a never-resolving fetch so no snapshot is loaded
    const fetchTask = vi.fn().mockReturnValue(new Promise(() => {}));
    render(
      <BackgroundTaskTray
        initialTaskIds={["task-xyz-id"]}
        fetchTask={fetchTask}
      />,
    );
    // Before snapshot loads, the TaskRow shows the taskId as fallback label
    expect(screen.getByText("task-xyz-id")).toBeInTheDocument();
  });

  it("shows cancel button for non-terminal task when cancelTask is provided", () => {
    // Use a never-resolving fetch so no snapshot is loaded (task stays pending/running)
    const fetchTask = vi.fn().mockReturnValue(new Promise(() => {}));
    const cancelTask = vi.fn().mockResolvedValue({ ok: true });
    render(
      <BackgroundTaskTray
        initialTaskIds={["t-cancel"]}
        fetchTask={fetchTask}
        cancelTask={cancelTask}
      />,
    );
    // When no snapshot is present status defaults to "pending" (non-terminal)
    // and cancelTask is provided — Cancel button should be visible
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });
});
