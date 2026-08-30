// @vitest-environment jsdom
/**
 * subagent-fanout.test.tsx
 *
 * Render + interaction tests for SubagentFanout:
 *   - Shows the subagent count
 *   - Shows each child agent card
 *   - Renders the correct status text for each fanout status
 *   - Calls onSelectChild when a child card is clicked
 *   - Renders aggregated results panel when non-running and results exist
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubagentFanout } from "./subagent-fanout";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Check: vi.fn(() => <span data-testid="icon-check" />),
    Loader2: vi.fn(() => <span data-testid="icon-loader" />),
    Users: vi.fn(() => <span data-testid="icon-users" />),
    X: vi.fn(() => <span data-testid="icon-x" />),
  };
});

const BASE_SUBAGENTS = [
  {
    childMessageId: "child-1",
    capability: "search",
    label: "Search Agent",
    status: "running" as const,
  },
  {
    childMessageId: "child-2",
    capability: "summarise",
    label: "Summarise Agent",
    status: "completed" as const,
  },
];

describe("SubagentFanout", () => {
  it("renders the subagent count", () => {
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="running"
      />,
    );
    expect(screen.getByText("2 subagents")).toBeInTheDocument();
  });

  it("renders labels for each child agent", () => {
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="running"
      />,
    );
    expect(screen.getByText("Search Agent")).toBeInTheDocument();
    expect(screen.getByText("Summarise Agent")).toBeInTheDocument();
  });

  it("falls back to capability when no label", () => {
    const subagents = [
      {
        childMessageId: "c1",
        capability: "my.capability",
        status: "running" as const,
      },
    ];
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={subagents}
        status="running"
      />,
    );
    // capability appears in both truncated label span and mono span; just assert at least one exists
    expect(screen.getAllByText("my.capability").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("calls onSelectChild with the correct childMessageId when clicked", async () => {
    const onSelectChild = vi.fn();
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="running"
        onSelectChild={onSelectChild}
      />,
    );
    const firstCard = screen.getByText("Search Agent").closest("button");
    await userEvent.click(firstCard!);
    expect(onSelectChild).toHaveBeenCalledWith("child-1");
  });

  it("does not throw when onSelectChild is not provided", async () => {
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="running"
      />,
    );
    const firstCard = screen.getByText("Search Agent").closest("button");
    await userEvent.click(firstCard!);
    // No error — passes if no exception thrown
  });

  it("renders aggregated results as a typed tree, not raw JSON", () => {
    const results = [{ childMessageId: "child-1", output: { found: true } }];
    const { container } = render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="completed"
        results={results}
      />,
    );
    expect(screen.getByText("Aggregated result")).toBeInTheDocument();
    // The output object renders structured (humanized key + Yes/No), not JSON.
    expect(screen.getByText("Found")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toContain("{");
  });

  it("does not render aggregated results when status is running", () => {
    const results = [{ childMessageId: "child-1", output: { found: true } }];
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="running"
        results={results}
      />,
    );
    expect(screen.queryByText("Aggregated result")).not.toBeInTheDocument();
  });

  it("shows a muted Running status for running status", () => {
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="running"
      />,
    );
    expect(screen.getByText("Running").className).toContain(
      "text-muted-foreground",
    );
  });

  it("shows a success-toned Completed status for completed status", () => {
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="completed"
      />,
    );
    expect(screen.getByText("Completed").className).toContain("text-success");
  });

  it("shows a destructive-toned Timed out status for timed_out status", () => {
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="timed_out"
      />,
    );
    expect(screen.getByText("Timed out").className).toContain(
      "text-destructive",
    );
  });

  it("shows a warning-toned Partial status for partial status", () => {
    render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="partial"
      />,
    );
    expect(screen.getByText("Partial").className).toContain("text-warning");
  });

  it("sets data-fanout-status attribute correctly", () => {
    const { container } = render(
      <SubagentFanout
        fanoutId="fan-1"
        parentMessageId="msg-1"
        subagents={BASE_SUBAGENTS}
        status="completed"
      />,
    );
    const root = container.querySelector("[data-component='subagent-fanout']");
    expect(root).toHaveAttribute("data-fanout-status", "completed");
  });
});
