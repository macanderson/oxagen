// @vitest-environment jsdom
/**
 * task-table.test.tsx — presentational tests for the parallel-task table.
 */
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";

// Any icon name resolves to a stub element. The `has` trap declares every icon
// as "present" (so named imports resolve) EXCEPT `then`: a catch-all that makes
// `then` a function turns this mock namespace thenable, so ESM resolution awaits
// a never-resolving function and hangs vitest when this file shares a worker with
// another suite — the root cause of the apps/app `test:unit` CI timeout.
vi.mock("lucide-react", () =>
  new Proxy(
    {},
    {
      get: (_t, prop) => (prop === "then" ? undefined : () => <svg aria-hidden="true" />),
      has: (_t, prop) => prop !== "then",
    },
  ),
);

import { TaskTable, type RunTask } from "./task-table";

function task(overrides: Partial<RunTask> = {}): RunTask {
  return {
    id: "t1",
    title: "Profile all F500 CEOs",
    goal: "research at scale",
    status: "running",
    durationLabel: "2m 1s",
    createdLabel: "Jun 6, 14:32",
    ...overrides,
  };
}

afterEach(cleanup);

describe("TaskTable", () => {
  it("renders a row per task with title, status label and duration", () => {
    render(
      <TaskTable
        tasks={[
          task(),
          task({ id: "t2", title: "Summarize report", status: "completed", durationLabel: "5m 0s" }),
        ]}
      />,
    );
    expect(screen.getByText("Profile all F500 CEOs")).toBeInTheDocument();
    expect(screen.getByText("Summarize report")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    // Each row renders its own duration cell.
    expect(screen.getByText("2m 1s")).toBeInTheDocument();
    expect(screen.getByText("5m 0s")).toBeInTheDocument();
  });

  it("falls back to an em dash when the title is empty", () => {
    render(<TaskTable tasks={[task({ title: "" })]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("maps an unknown status to the failed config without throwing", () => {
    render(<TaskTable tasks={[task({ status: "bogus" as RunTask["status"] })]} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
