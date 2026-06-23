/**
 * translate-stream.test.ts — verifies that capability tool results are
 * translated into the matching high-level chat-stream events (OXA-1469):
 *
 *   agent.plan.create         → plan-proposed
 *   agent.subagent.dispatch   → subagent-dispatched
 *   agent.memory.write        → memory-written
 *   agent.memory.recall       → memory-recalled
 *   agent.task.background.start → background-task-progress
 *
 * Also verifies the credits + token count emitted in the terminal `usage`
 * event is priced from the supplied (mock) meter markup.
 */
import { describe, it, expect, vi } from "vitest";
import { translateAgentStream } from "./translate-stream";
import type { StreamEvent } from "@/components/chat/stream-event-types";

vi.mock("@oxagen/billing", () => ({
  tokenUsageCreditsCeiling: (
    usage: { model: string; inputTokens: number; outputTokens: number },
    markup: number,
  ) => {
    // Trivial deterministic stub mirroring ceiling semantics — totalTokens × markup.
    return Math.ceil((usage.inputTokens + usage.outputTokens) * markup * 0.001);
  },
}));

vi.mock("@oxagen/oxagen/capability-meta", () => ({
  resolveRenderDirective: () => null,
}));

async function* arrayStream<T>(parts: T[]): AsyncIterable<T> {
  for (const p of parts) yield p;
}

interface Options {
  emit?: (event: StreamEvent) => void;
}

async function run(parts: unknown[], emit?: Options["emit"]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const captureEmit = (e: StreamEvent) => {
    events.push(e);
    emit?.(e);
  };
  await translateAgentStream({
    fullStream: arrayStream(parts) as AsyncIterable<unknown>,
    requestId: "req-1",
    toolNameMap: {},
    orgSlug: "acme",
    workspaceSlug: "main",
    emit: captureEmit,
    modelId: "anthropic/claude-sonnet-4.6",
    meterMarkup: 3,
  });
  return events;
}

describe("translateAgentStream — capability → high-level event translation", () => {
  it("forwards a plan-proposed event when agent.plan.create returns a plan", async () => {
    const events = await run([
      { type: "tool-call", toolCallId: "tc-1", toolName: "agent.plan.create", input: {} },
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "agent.plan.create",
        output: {
          planId: "plan-7",
          status: "awaiting_approval",
          goals: ["Ship OXA-1469"],
          tasks: [
            { id: "t1", title: "Wire footer", dependsOn: [] },
            { id: "t2", title: "Write tests", dependsOn: ["t1"] },
          ],
          approvalRequired: true,
          createdAt: "2026-06-21T00:00:00.000Z",
        },
      },
    ]);
    const planEvent = events.find((e) => e.type === "plan-proposed");
    expect(planEvent).toBeDefined();
    if (planEvent && planEvent.type === "plan-proposed") {
      expect(planEvent.planId).toBe("plan-7");
      expect(planEvent.title).toBe("Ship OXA-1469");
      expect(planEvent.steps).toHaveLength(2);
      expect(planEvent.steps[1]?.dependsOn).toEqual(["t1"]);
    }
  });

  it("forwards subagent-dispatched when agent.subagent.dispatch returns a dispatchId", async () => {
    const events = await run([
      {
        type: "tool-call",
        toolCallId: "tc-2",
        toolName: "agent.subagent.dispatch",
        input: {
          parentMessageId: "msg-9",
          tasks: [
            { capabilityName: "agent.compose", input: {} },
            { capabilityName: "graph.node.list", input: {} },
          ],
        },
      },
      {
        type: "tool-result",
        toolCallId: "tc-2",
        toolName: "agent.subagent.dispatch",
        output: { dispatchId: "fan-42", totalTasks: 2, status: "running" },
      },
    ]);
    const ev = events.find((e) => e.type === "subagent-dispatched");
    expect(ev).toBeDefined();
    if (ev && ev.type === "subagent-dispatched") {
      expect(ev.fanoutId).toBe("fan-42");
      expect(ev.children.map((c) => c.capability)).toEqual(["agent.compose", "graph.node.list"]);
    }
  });

  it("forwards memory-written when agent.memory.write completes", async () => {
    const events = await run([
      {
        type: "tool-call",
        toolCallId: "tc-3",
        toolName: "agent.memory.write",
        input: { nodeRef: "node-abc", weight: "fact" },
      },
      {
        type: "tool-result",
        toolCallId: "tc-3",
        toolName: "agent.memory.write",
        output: { memoryId: "mem-1", nodeRef: "node-abc", edgesCreated: 1 },
      },
    ]);
    const ev = events.find((e) => e.type === "memory-written");
    expect(ev).toBeDefined();
    if (ev && ev.type === "memory-written") {
      expect(ev.memoryId).toBe("mem-1");
      expect(ev.nodeRef).toBe("node-abc");
      expect(ev.weight).toBe("fact");
    }
  });

  it("forwards memory-recalled when agent.memory.recall returns hits", async () => {
    const events = await run([
      { type: "tool-call", toolCallId: "tc-4", toolName: "agent.memory.recall", input: {} },
      {
        type: "tool-result",
        toolCallId: "tc-4",
        toolName: "agent.memory.recall",
        output: {
          memories: [
            { id: "m1", lesson: "Cache the prompt", weight: "fact", score: 0.92, nodeRef: "node-a" },
          ],
        },
      },
    ]);
    const ev = events.find((e) => e.type === "memory-recalled");
    expect(ev).toBeDefined();
    if (ev && ev.type === "memory-recalled") {
      expect(ev.memories).toHaveLength(1);
      expect(ev.memories[0]?.lesson).toBe("Cache the prompt");
    }
  });

  it("forwards background-task-progress when agent.task.background.start returns a task handle", async () => {
    const events = await run([
      {
        type: "tool-call",
        toolCallId: "tc-5",
        toolName: "agent.task.background.start",
        input: { kind: "graph.ingest", payload: {}, label: "Ingest large doc" },
      },
      {
        type: "tool-result",
        toolCallId: "tc-5",
        toolName: "agent.task.background.start",
        output: { taskId: "task-9", inngestRunId: "run-7" },
      },
    ]);
    const ev = events.find((e) => e.type === "background-task-progress");
    expect(ev).toBeDefined();
    if (ev && ev.type === "background-task-progress") {
      expect(ev.taskId).toBe("task-9");
      expect(ev.kind).toBe("graph.ingest");
      expect(ev.label).toBe("Ingest large doc");
      expect(ev.status).toBe("queued");
      expect(ev.inngestRunId).toBe("run-7");
    }
  });

  it("prices the terminal usage event using the supplied meter markup", async () => {
    const events = await run([
      { type: "text-delta", text: "hi" },
      { type: "finish", totalUsage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 } },
    ]);
    const ev = events.find((e) => e.type === "usage");
    expect(ev).toBeDefined();
    if (ev && ev.type === "usage") {
      expect(ev.usage.totalTokens).toBe(1_500);
      // Our stub: ceiling((1000+500) * 3 * 0.001) = 5
      expect(ev.usage.creditsCharged).toBe(5);
    }
  });

  it("returns the captured usage so the route can persist it under message metadata", async () => {
    const result = await translateAgentStream({
      fullStream: arrayStream([
        { type: "text-delta", text: "hi" },
        { type: "finish", totalUsage: { inputTokens: 1_000, outputTokens: 0, totalTokens: 1_000 } },
      ]) as AsyncIterable<unknown>,
      requestId: "req-2",
      toolNameMap: {},
      orgSlug: "acme",
      workspaceSlug: "main",
      emit: () => undefined,
      modelId: "anthropic/claude-sonnet-4.6",
      meterMarkup: 3,
    });
    expect(result.assistantText).toBe("hi");
    expect(result.usage).toEqual(
      expect.objectContaining({
        promptTokens: 1_000,
        completionTokens: 0,
        totalTokens: 1_000,
        creditsCharged: 3,
      }),
    );
  });

  it("emits no creditsCharged > 0 for a zero-token finish (error before LLM call)", async () => {
    const events = await run([
      { type: "finish", totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ]);
    const ev = events.find((e) => e.type === "usage");
    expect(ev).toBeDefined();
    if (ev && ev.type === "usage") {
      expect(ev.usage.creditsCharged).toBe(0);
      expect(ev.usage.totalTokens).toBe(0);
    }
  });
});
