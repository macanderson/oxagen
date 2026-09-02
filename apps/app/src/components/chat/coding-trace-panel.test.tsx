// @vitest-environment jsdom
/**
 * coding-trace-panel.test.tsx
 *
 * Covers:
 *   - groupCodingTraceStages (pure): buckets plan/tool/code/subagent/result
 *     correctly, including the code-vs-generic-tool split via
 *     isCodeRunCapability.
 *   - CodingTracePanel (render): renders nothing when the turn has no
 *     content, renders stage sections with counts, each row deep-links to
 *     `#turn-entry-<key>`, collapse toggle hides the stage list.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LiveFanout, LivePlan, LiveToolCall } from "./use-tool-stream";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

function makeToolCall(overrides: Partial<LiveToolCall> = {}): LiveToolCall {
  return {
    toolCallId: "tc_1",
    messageId: "m_1",
    capability: "graph.query",
    inputPreview: {},
    riskLevel: "low",
    status: "completed",
    stdout: "",
    stderr: "",
    startedAt: Date.now(),
    ...overrides,
  };
}

function makePlan(overrides: Partial<LivePlan> = {}): LivePlan {
  return {
    planId: "plan_1",
    title: "Refactor the widget",
    steps: [],
    status: "pending",
    ...overrides,
  };
}

function makeFanout(overrides: Partial<LiveFanout> = {}): LiveFanout {
  return {
    fanoutId: "fanout_1",
    parentMessageId: "m_1",
    children: [
      {
        childMessageId: "c1",
        capability: "dispatch_subagent",
        status: "running",
      },
      {
        childMessageId: "c2",
        capability: "dispatch_subagent",
        status: "running",
      },
    ],
    status: "running",
    ...overrides,
  };
}

describe("isCodeRunCapability", () => {
  it("classifies known code-run capabilities as code runs", async () => {
    const { isCodeRunCapability } = await import("./coding-trace-panel");
    expect(isCodeRunCapability("execute_code")).toBe(true);
    expect(isCodeRunCapability("run_sandbox_command")).toBe(true);
    expect(isCodeRunCapability("start_sandbox")).toBe(true);
    expect(isCodeRunCapability("put_repo_file")).toBe(true);
    expect(isCodeRunCapability("open_pr")).toBe(true);
  });

  it("classifies everything else as a generic tool call", async () => {
    const { isCodeRunCapability } = await import("./coding-trace-panel");
    expect(isCodeRunCapability("graph.query")).toBe(false);
    expect(isCodeRunCapability("memory.recall")).toBe(false);
    expect(isCodeRunCapability("search_web")).toBe(false);
  });
});

describe("groupCodingTraceStages", () => {
  it("buckets a plan into the plan stage", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const plan = makePlan();
    const groups = groupCodingTraceStages({
      order: ["plan:plan_1"],
      plans: { plan_1: plan },
      toolCalls: {},
      activeFanouts: {},
      turnUsage: undefined,
      isStreaming: true,
    });
    expect(groups.plan).toHaveLength(1);
    expect(groups.plan[0]).toMatchObject({
      label: "Refactor the widget",
      tone: "running",
      anchorId: "turn-entry-plan:plan_1",
    });
    expect(groups.tool).toHaveLength(0);
  });

  it("splits tool calls into generic 'tool' vs 'code' buckets by capability", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const generic = makeToolCall({
      toolCallId: "tc_generic",
      capability: "graph.query",
    });
    const codeRun = makeToolCall({
      toolCallId: "tc_code",
      capability: "execute_code",
    });
    const groups = groupCodingTraceStages({
      order: ["tool:tc_generic", "tool:tc_code"],
      plans: {},
      toolCalls: { tc_generic: generic, tc_code: codeRun },
      activeFanouts: {},
      turnUsage: undefined,
      isStreaming: true,
    });
    expect(groups.tool).toHaveLength(1);
    expect(groups.tool[0]?.label).toBe("graph.query");
    expect(groups.code).toHaveLength(1);
    expect(groups.code[0]?.label).toBe("execute_code");
  });

  it("maps tool-call status to tone (failed/running/done)", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const failed = makeToolCall({ toolCallId: "tc_failed", status: "failed" });
    const running = makeToolCall({
      toolCallId: "tc_running",
      status: "running",
    });
    const groups = groupCodingTraceStages({
      order: ["tool:tc_failed", "tool:tc_running"],
      plans: {},
      toolCalls: { tc_failed: failed, tc_running: running },
      activeFanouts: {},
      turnUsage: undefined,
      isStreaming: true,
    });
    const failedRow = groups.tool.find((r) => r.key === "tool:tc_failed");
    const runningRow = groups.tool.find((r) => r.key === "tool:tc_running");
    expect(failedRow?.tone).toBe("failed");
    expect(runningRow?.tone).toBe("running");
    expect(runningRow?.active).toBe(true);
  });

  it("buckets a subagent fanout into the subagent stage with a child count label", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const groups = groupCodingTraceStages({
      order: ["fanout:fanout_1"],
      plans: {},
      toolCalls: {},
      activeFanouts: { fanout_1: makeFanout() },
      turnUsage: undefined,
      isStreaming: true,
    });
    expect(groups.subagent).toHaveLength(1);
    expect(groups.subagent[0]?.label).toBe("2 subagents");
    expect(groups.subagent[0]?.tone).toBe("running");
  });

  it("maps a completed fanout to tone 'done' and a non-running/completed fanout to 'failed'", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const completed = makeFanout({
      fanoutId: "fanout_done",
      status: "completed",
    });
    const timedOut = makeFanout({
      fanoutId: "fanout_timeout",
      status: "timed_out",
    });
    const groups = groupCodingTraceStages({
      order: ["fanout:fanout_done", "fanout:fanout_timeout"],
      plans: {},
      toolCalls: {},
      activeFanouts: { fanout_done: completed, fanout_timeout: timedOut },
      turnUsage: undefined,
      isStreaming: false,
    });
    const doneRow = groups.subagent.find((r) => r.key === "fanout:fanout_done");
    const timeoutRow = groups.subagent.find(
      (r) => r.key === "fanout:fanout_timeout",
    );
    expect(doneRow?.tone).toBe("done");
    expect(doneRow?.active).toBe(false);
    expect(timeoutRow?.tone).toBe("failed");
    expect(timeoutRow?.active).toBe(false);
  });

  it("maps a resolved (non-pending) plan to tone 'done'", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const approved = makePlan({ status: "approved" });
    const groups = groupCodingTraceStages({
      order: ["plan:plan_1"],
      plans: { plan_1: approved },
      toolCalls: {},
      activeFanouts: {},
      turnUsage: undefined,
      isStreaming: false,
    });
    expect(groups.plan[0]?.tone).toBe("done");
    expect(groups.plan[0]?.active).toBe(false);
  });

  it("adds a 'Turn complete' result row once turnUsage lands", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const groups = groupCodingTraceStages({
      order: [],
      plans: {},
      toolCalls: {},
      activeFanouts: {},
      turnUsage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0,
      } as never,
      isStreaming: false,
    });
    expect(groups.result).toHaveLength(1);
    expect(groups.result[0]).toMatchObject({
      label: "Turn complete",
      anchorId: "turn-result",
    });
  });

  it("shows an 'In progress…' result row while still streaming with no usage yet", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const groups = groupCodingTraceStages({
      order: [],
      plans: {},
      toolCalls: {},
      activeFanouts: {},
      turnUsage: undefined,
      isStreaming: true,
    });
    expect(groups.result).toHaveLength(1);
    expect(groups.result[0]?.label).toBe("In progress…");
    expect(groups.result[0]?.anchorId).toBeUndefined();
  });

  it("ignores order keys that reference entities no longer present in state", async () => {
    const { groupCodingTraceStages } = await import("./coding-trace-panel");
    const groups = groupCodingTraceStages({
      order: ["plan:missing", "tool:missing", "fanout:missing", "text:m1:0"],
      plans: {},
      toolCalls: {},
      activeFanouts: {},
      turnUsage: undefined,
      isStreaming: false,
    });
    expect(groups.plan).toHaveLength(0);
    expect(groups.tool).toHaveLength(0);
    expect(groups.code).toHaveLength(0);
    expect(groups.subagent).toHaveLength(0);
    expect(groups.result).toHaveLength(0);
  });
});

describe("CodingTracePanel", () => {
  it("renders nothing when there is no turn content", async () => {
    const { CodingTracePanel } = await import("./coding-trace-panel");
    const { container } = render(
      <CodingTracePanel
        order={[]}
        plans={{}}
        toolCalls={{}}
        activeFanouts={{}}
        turnUsage={undefined}
        isStreaming={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders stage sections with row counts and deep-link hrefs", async () => {
    const { CodingTracePanel } = await import("./coding-trace-panel");
    const codeRun = makeToolCall({
      toolCallId: "tc_code",
      capability: "execute_code",
    });
    render(
      <CodingTracePanel
        order={["plan:plan_1", "tool:tc_code"]}
        plans={{ plan_1: makePlan() }}
        toolCalls={{ tc_code: codeRun }}
        activeFanouts={{}}
        turnUsage={undefined}
        isStreaming={true}
      />,
    );
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Code runs")).toBeInTheDocument();
    const codeLink = screen.getByTestId("trace-row-tool:tc_code");
    expect(codeLink).toHaveAttribute("href", "#turn-entry-tool:tc_code");
    const planLink = screen.getByTestId("trace-row-plan:plan_1");
    expect(planLink).toHaveAttribute("href", "#turn-entry-plan:plan_1");
  });

  it("collapses to hide the stage list and expands again on toggle", async () => {
    const { CodingTracePanel } = await import("./coding-trace-panel");
    render(
      <CodingTracePanel
        order={["plan:plan_1"]}
        plans={{ plan_1: makePlan() }}
        toolCalls={{}}
        activeFanouts={{}}
        turnUsage={undefined}
        isStreaming={true}
      />,
    );
    expect(screen.getByText("Plan")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Collapse turn trace"));
    expect(screen.queryByText("Plan")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Expand turn trace"));
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("toggles an individual stage section open/closed", async () => {
    const { CodingTracePanel } = await import("./coding-trace-panel");
    render(
      <CodingTracePanel
        order={["plan:plan_1"]}
        plans={{ plan_1: makePlan() }}
        toolCalls={{}}
        activeFanouts={{}}
        turnUsage={undefined}
        isStreaming={true}
      />,
    );
    expect(screen.getByTestId("trace-row-plan:plan_1")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Plan"));
    expect(
      screen.queryByTestId("trace-row-plan:plan_1"),
    ).not.toBeInTheDocument();
  });
});
