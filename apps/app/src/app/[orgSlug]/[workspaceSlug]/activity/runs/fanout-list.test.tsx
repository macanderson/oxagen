// @vitest-environment jsdom
/**
 * fanout-list.test.tsx — component tests for FanoutList.
 *
 * Covers: empty state, populated rows with status badge + progress, detail
 * links, and live polling (refreshes while a fan-out is live, stops when all
 * terminal).
 */
import * as React from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ listFanoutsAction: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("lucide-react", () => ({ Network: () => <svg aria-hidden="true" /> }));
vi.mock("./fanout-actions", () => ({ listFanoutsAction: mocks.listFanoutsAction }));

import { FanoutList, type FanoutRow } from "./fanout-list";

const baseProps = { orgSlug: "acme", workspaceSlug: "prod" };

function row(overrides: Partial<FanoutRow> = {}): FanoutRow {
  return {
    fanoutId: "fan_1",
    parentMessageId: "msg_1",
    status: "running",
    totalChildren: 3,
    completedChildren: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("FanoutList", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the empty state when there are no fan-outs", () => {
    render(<FanoutList {...baseProps} initialFanouts={[]} />);
    expect(screen.getByText(/no subagent fan-outs yet/i)).toBeInTheDocument();
  });

  it("renders a row per fan-out with status, progress, and a detail link", () => {
    render(<FanoutList {...baseProps} initialFanouts={[row(), row({ fanoutId: "fan_2", status: "completed" })]} />);
    expect(screen.getByText("fan_1")).toBeInTheDocument();
    expect(screen.getByText("fan_2")).toBeInTheDocument();
    expect(screen.getAllByText(/1 \/ 3 children/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    const link = screen.getByText("fan_1").closest("a");
    expect(link).toHaveAttribute("href", "/acme/prod/activity/runs/fan_1");
  });

  it("polls and refreshes while a fan-out is live", async () => {
    vi.useFakeTimers();
    mocks.listFanoutsAction.mockResolvedValue({
      fanouts: [row({ status: "completed", completedChildren: 3 })],
    });
    render(<FanoutList {...baseProps} initialFanouts={[row()]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mocks.listFanoutsAction).toHaveBeenCalledWith({ orgSlug: "acme", workspaceSlug: "prod" });
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("does not poll when all fan-outs are terminal", async () => {
    vi.useFakeTimers();
    render(<FanoutList {...baseProps} initialFanouts={[row({ status: "completed" })]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(mocks.listFanoutsAction).not.toHaveBeenCalled();
  });
});
