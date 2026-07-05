// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentTraceGetOutput } from "@oxagen/oxagen/contracts/agent.trace.get";
import { SpanTree } from "./span-tree";

afterEach(cleanup);

function trace(): AgentTraceGetOutput {
  return {
    executionId: "aex_root",
    status: "completed",
    originType: "chat",
    originId: "00000000-0000-4000-8000-000000000001",
    agentId: null,
    failureReason: null,
    startedAt: "2026-06-16T00:00:00.000Z",
    completedAt: "2026-06-16T00:00:04.000Z",
    latencyMs: 4000,
    inputTokens: 120,
    outputTokens: 60,
    estimatedCostUsd: "0.012000",
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:04.000Z",
    steps: [
      {
        stepId: "aes_1",
        stepNumber: 1,
        stepType: "tool_call",
        status: "completed",
        failureReason: null,
        startedAt: "2026-06-16T00:00:01.000Z",
        completedAt: "2026-06-16T00:00:02.000Z",
        latencyMs: 1000,
        inputTokens: 10,
        outputTokens: 5,
        toolCalls: [
          {
            toolCallId: "atc_1",
            toolName: "ontology.neighbors",
            toolType: "capability",
            status: "completed",
            latencyMs: 800,
            inputTokens: 4,
            outputTokens: 2,
            requestBytes: 12,
            responseBytes: 34,
            responsePreview: '{"neighbors":["a","b"]}',
          },
        ],
      },
    ],
    children: [
      {
        executionId: "aex_child",
        status: "running",
        originType: "fanout",
        originId: "00000000-0000-4000-8000-000000000002",
        agentId: null,
        failureReason: null,
        startedAt: "2026-06-16T00:00:01.000Z",
        completedAt: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
        createdAt: "2026-06-16T00:00:01.000Z",
        updatedAt: "2026-06-16T00:00:02.000Z",
        steps: [],
        children: [],
      },
    ],
  };
}

describe("SpanTree", () => {
  it("renders the root execution, its step, and tool call (default-expanded)", () => {
    render(<SpanTree trace={trace()} />);
    // Root id appears (in the tree row and the default detail panel).
    expect(screen.getAllByText("aex_root").length).toBeGreaterThan(0);
    expect(screen.getByText("step 1")).toBeInTheDocument();
    expect(screen.getByText("ontology.neighbors")).toBeInTheDocument();
    // Child execution row renders too.
    expect(screen.getByText("aex_child")).toBeInTheDocument();
  });

  it("shows the response preview in the detail panel when a tool call is selected", async () => {
    const user = userEvent.setup();
    render(<SpanTree trace={trace()} />);
    await user.click(screen.getByText("ontology.neighbors"));
    expect(screen.getByText("Response preview")).toBeInTheDocument();
    expect(
      screen.getByText('{"neighbors":["a","b"]}'),
    ).toBeInTheDocument();
  });

  it("collapses the root, hiding descendant rows", async () => {
    const user = userEvent.setup();
    render(<SpanTree trace={trace()} />);
    // The first Collapse toggle is the root's.
    const collapseButtons = screen.getAllByRole("button", { name: "Collapse" });
    await user.click(collapseButtons[0]!);
    expect(screen.queryByText("step 1")).not.toBeInTheDocument();
    expect(screen.queryByText("ontology.neighbors")).not.toBeInTheDocument();
  });

  it("copies an id from the detail panel", async () => {
    // userEvent.setup() installs a clipboard stub we can read back.
    const user = userEvent.setup();
    render(<SpanTree trace={trace()} />);
    // Default selection is the root execution → its detail panel has copyable
    // execution + origin id buttons.
    const copyBtns = screen.getAllByTitle("Copy id");
    await user.click(copyBtns[0]!);
    await expect(navigator.clipboard.readText()).resolves.toBe("aex_root");
  });

  it("renders turn metrics + determinism badge when the handler populates them (OXA-2071)", () => {
    const withMetrics: AgentTraceGetOutput = {
      ...trace(),
      turnMetrics: [
        { turnId: "aes_1", compileMs: 1000, tokens: 15, cacheHitRate: 0, toolCalls: 1, outcome: "success" },
      ],
      replayDeterministic: true,
    };
    render(<SpanTree trace={withMetrics} />);
    expect(screen.getByText("Turn metrics")).toBeInTheDocument();
    expect(screen.getByText("deterministic")).toBeInTheDocument();
    expect(screen.getByText(/1000ms · 15 tok · 1 tool · success/)).toBeInTheDocument();
  });

  it("omits the turn-metrics panel when the handler didn't populate it", () => {
    render(<SpanTree trace={trace()} />);
    expect(screen.queryByText("Turn metrics")).not.toBeInTheDocument();
  });
});
