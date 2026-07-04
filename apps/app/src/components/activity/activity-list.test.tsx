// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentExecutionListOutput } from "@oxagen/oxagen/contracts/agent.execution.list";
import { ActivityList } from "./activity-list";

// next/link → plain anchor so href assertions work in jsdom.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

type Execution = AgentExecutionListOutput["executions"][number];

function run(overrides: Partial<Execution> = {}): Execution {
  return {
    executionId: "aex_abc",
    status: "completed",
    originType: "chat",
    originId: "00000000-0000-4000-8000-000000000001",
    agentId: null,
    startedAt: "2026-06-16T00:00:00.000Z",
    completedAt: "2026-06-16T00:00:04.000Z",
    latencyMs: 4000,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: "0.012000",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ActivityList", () => {
  it("renders the empty state when there are no runs", () => {
    render(<ActivityList executions={[]} nextCursor={null} basePath="/o/w/activity" />);
    expect(screen.getByText(/no agent runs yet/i)).toBeInTheDocument();
  });

  it("renders a row per run, linking to its trace page", () => {
    render(
      <ActivityList
        executions={[run(), run({ executionId: "aex_def", originType: "fanout" })]}
        nextCursor={null}
        basePath="/o/w/activity"
      />,
    );
    expect(screen.getByText("aex_abc")).toBeInTheDocument();
    expect(screen.getByText("aex_def")).toBeInTheDocument();
    const link = screen.getByText("aex_abc").closest("a");
    expect(link).toHaveAttribute("href", "/o/w/activity/aex_abc");
    // Cost + duration are rendered (one per row).
    expect(screen.getAllByText("$0.01").length).toBeGreaterThan(0);
  });

  it("renders a 'Load older runs' link when a nextCursor is present", () => {
    render(
      <ActivityList
        executions={[run()]}
        nextCursor="2026-06-16T00:00:00.000Z"
        basePath="/o/w/activity"
      />,
    );
    const more = screen.getByText(/load older runs/i).closest("a");
    expect(more).toHaveAttribute(
      "href",
      "/o/w/activity?before=2026-06-16T00%3A00%3A00.000Z",
    );
  });

  it("does not render pagination when nextCursor is null", () => {
    render(<ActivityList executions={[run()]} nextCursor={null} basePath="/o/w/activity" />);
    expect(screen.queryByText(/load older runs/i)).not.toBeInTheDocument();
  });
});
