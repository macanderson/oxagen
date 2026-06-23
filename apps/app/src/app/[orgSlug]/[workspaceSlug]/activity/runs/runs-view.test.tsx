// @vitest-environment jsdom
/**
 * runs-view.test.tsx — filter-chip behavior for the unified Runs surface.
 *
 * FanoutList and TaskTable are stubbed so these tests focus purely on the
 * chip/empty-state logic of RunsView.
 */
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi } from "vitest";

// The `has` trap declares every icon as "present" (so named imports resolve)
// EXCEPT `then`: a catch-all that makes `then` a function turns this mock
// namespace thenable, so ESM resolution awaits a never-resolving function and
// hangs vitest when this file shares a worker with another suite — the root cause
// of the apps/app `test:unit` CI timeout.
vi.mock("lucide-react", () =>
  new Proxy(
    {},
    {
      get: (_t, prop) => (prop === "then" ? undefined : () => <svg aria-hidden="true" />),
      has: (_t, prop) => prop !== "then",
    },
  ),
);
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./fanout-list", () => ({
  FanoutList: ({ initialFanouts }: { initialFanouts: unknown[] }) => (
    <div data-testid="fanout-list">fanouts:{initialFanouts.length}</div>
  ),
}));
vi.mock("./task-table", () => ({
  TaskTable: ({ tasks }: { tasks: unknown[] }) => <div data-testid="task-table">tasks:{tasks.length}</div>,
}));

import { RunsView } from "./runs-view";
import type { FanoutRow } from "./fanout-list";
import type { RunTask } from "./task-table";

const fanout = {} as FanoutRow;
const taskRow = {} as RunTask;
const baseProps = { orgSlug: "acme", workspaceSlug: "prod" };

afterEach(cleanup);

describe("RunsView", () => {
  it("renders both run kinds under the default 'All' filter", () => {
    render(<RunsView {...baseProps} fanouts={[fanout, fanout]} tasks={[taskRow]} />);
    expect(screen.getByTestId("fanout-list")).toHaveTextContent("fanouts:2");
    expect(screen.getByTestId("task-table")).toHaveTextContent("tasks:1");
    // Chip counts: All=3, fan-outs=2, tasks=1 (label and count render adjacent).
    expect(screen.getByRole("tab", { name: /All\s*3/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Subagent fan-outs\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Parallel tasks\s*1/ })).toBeInTheDocument();
  });

  it("shows only fan-outs when the 'Subagent fan-outs' chip is selected", async () => {
    render(<RunsView {...baseProps} fanouts={[fanout]} tasks={[taskRow]} />);
    await userEvent.click(screen.getByRole("tab", { name: /Subagent fan-outs/ }));
    expect(screen.getByTestId("fanout-list")).toBeInTheDocument();
    expect(screen.queryByTestId("task-table")).toBeNull();
  });

  it("shows only tasks when the 'Parallel tasks' chip is selected", async () => {
    render(<RunsView {...baseProps} fanouts={[fanout]} tasks={[taskRow]} />);
    await userEvent.click(screen.getByRole("tab", { name: /Parallel tasks/ }));
    expect(screen.getByTestId("task-table")).toBeInTheDocument();
    expect(screen.queryByTestId("fanout-list")).toBeNull();
  });

  it("renders a single combined empty state when there are no runs at all", () => {
    render(<RunsView {...baseProps} fanouts={[]} tasks={[]} />);
    expect(screen.getByText(/no runs yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("fanout-list")).toBeNull();
    expect(screen.queryByTestId("task-table")).toBeNull();
  });

  it("notes that chat / API / MCP runs are coming soon", () => {
    render(<RunsView {...baseProps} fanouts={[fanout]} tasks={[]} />);
    expect(screen.getByText(/chat \/ api \/ mcp runs coming soon/i)).toBeInTheDocument();
  });
});
