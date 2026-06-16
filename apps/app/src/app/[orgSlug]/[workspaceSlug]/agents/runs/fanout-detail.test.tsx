// @vitest-environment jsdom
/**
 * fanout-detail.test.tsx — component tests for FanoutDetail.
 *
 * Covers: aggregate header, per-run rows (capability, status, duration, error,
 * output preview), the back link, and live polling that settles on terminal.
 */
import * as React from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { AgentSubagentFanoutGetOutput } from "@oxagen/oxagen/contracts/agent.subagent.fanout.get";

const mocks = vi.hoisted(() => ({ getFanoutAction: vi.fn() }));

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
vi.mock("lucide-react", () => ({ ArrowLeft: () => <svg aria-hidden="true" /> }));
vi.mock("./fanout-actions", () => ({ getFanoutAction: mocks.getFanoutAction }));

import { FanoutDetail } from "./fanout-detail";

const baseProps = { orgSlug: "acme", workspaceSlug: "prod" };

function fanout(overrides: Partial<AgentSubagentFanoutGetOutput> = {}): AgentSubagentFanoutGetOutput {
  return {
    fanoutId: "fan_1",
    parentMessageId: "msg_1",
    status: "running",
    totalChildren: 2,
    completedChildren: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runs: [
      {
        runId: "sar_1",
        capabilityName: "agent.tool.list",
        status: "completed",
        errorReason: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1500,
        inputBytes: 10,
        outputBytes: 42,
        outputPreview: '{"tools":[]}',
      },
      {
        runId: "sar_2",
        capabilityName: "agent.memory.recall",
        status: "failed",
        errorReason: "boom",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        inputBytes: 5,
        outputBytes: 0,
        outputPreview: null,
      },
    ],
    ...overrides,
  };
}

describe("FanoutDetail", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the aggregate header and a back link", () => {
    render(<FanoutDetail {...baseProps} initialFanout={fanout()} />);
    expect(screen.getByText("fan_1")).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2 children complete/i)).toBeInTheDocument();
    const back = screen.getByText(/back to fan-outs/i).closest("a");
    expect(back).toHaveAttribute("href", "/acme/prod/agents/runs");
  });

  it("renders each child run with capability, duration, and status", () => {
    render(<FanoutDetail {...baseProps} initialFanout={fanout()} />);
    expect(screen.getByText("agent.tool.list")).toBeInTheDocument();
    expect(screen.getByText("agent.memory.recall")).toBeInTheDocument();
    expect(screen.getByText(/duration: 1\.5s/i)).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows the error reason and output preview", () => {
    render(<FanoutDetail {...baseProps} initialFanout={fanout()} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText('{"tools":[]}')).toBeInTheDocument();
  });

  it("polls while live and settles when terminal", async () => {
    vi.useFakeTimers();
    mocks.getFanoutAction.mockResolvedValue(fanout({ status: "completed", completedChildren: 2 }));
    render(<FanoutDetail {...baseProps} initialFanout={fanout()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.getFanoutAction).toHaveBeenCalledWith(
      { orgSlug: "acme", workspaceSlug: "prod" },
      "fan_1",
    );
    expect(screen.getByText(/2 \/ 2 children complete/i)).toBeInTheDocument();
  });

  it("does not poll when the fan-out is already terminal", async () => {
    vi.useFakeTimers();
    render(<FanoutDetail {...baseProps} initialFanout={fanout({ status: "completed" })} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(mocks.getFanoutAction).not.toHaveBeenCalled();
  });
});
