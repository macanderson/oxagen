import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

import { withTenantDb } from "@oxagen/database";
import { agentTraceGetHandler } from "./agent.trace.get";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

interface ExecRow {
  id: string;
  publicId: string;
  agentId: string | null;
  originType: string;
  originId: string;
  status: string;
  failureReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: string | null;
  parentExecutionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface StepRow {
  id: string;
  publicId: string;
  executionId: string;
  stepNumber: number;
  stepType: string;
  status: string;
  failureReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}
interface ToolRow {
  id: string;
  publicId: string;
  executionStepId: string;
  toolName: string;
  toolType: string;
  status: string;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requestPayload: unknown;
  responsePayload: unknown;
}

function exec(overrides: Partial<ExecRow> = {}): ExecRow {
  return {
    id: "aexuuid_root",
    publicId: "aex_root",
    agentId: null,
    originType: "chat",
    originId: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    failureReason: null,
    startedAt: new Date("2026-06-16T00:00:00Z"),
    completedAt: new Date("2026-06-16T00:00:04Z"),
    latencyMs: 4000,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: "0.012000",
    parentExecutionId: null,
    createdAt: new Date("2026-06-16T00:00:00Z"),
    updatedAt: new Date("2026-06-16T00:00:04Z"),
    ...overrides,
  };
}

/**
 * The handler's query sequence:
 *   1) withTenantDb #1: root select (select→from→where→limit), then a BFS loop
 *      of child selects (select→from→where→orderBy) inside the SAME callback.
 *   2) withTenantDb #2: steps (select→from→where→orderBy).
 *   3) withTenantDb #3: tool calls (select→from→where→orderBy), only when steps exist.
 *
 * We drive #1 by returning the root once, then successive child batches per
 * `parentExecutionId` frontier until exhausted.
 */
function setup(args: {
  root: ExecRow | null;
  children?: ExecRow[]; // one level of descendants (keyed by parentExecutionId)
  steps?: StepRow[];
  tools?: ToolRow[];
}) {
  const { root, children = [], steps = [], tools = [] } = args;
  let dbCall = 0;
  vi.mocked(withTenantDb).mockImplementation((fn) => {
    if (typeof fn !== "function") return undefined as never;
    const call = dbCall;
    dbCall += 1;
    if (call === 0) {
      // Root + BFS child queries share this one callback.
      let childBatchServed = false;
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              // Root resolution.
              limit: () => Promise.resolve(root ? [root] : []),
              // BFS child batch: serve descendants once, then empty to end loop.
              orderBy: () => {
                if (!childBatchServed) {
                  childBatchServed = true;
                  return Promise.resolve(children);
                }
                return Promise.resolve([]);
              },
            }),
          }),
        }),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    }
    if (call === 1) {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ orderBy: () => Promise.resolve(steps) }),
          }),
        }),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    }
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => Promise.resolve(tools) }),
        }),
      }),
    };
    return fn(tx as unknown as Parameters<typeof fn>[0]);
  });
}

describe("agent.trace.get handler", () => {
  beforeEach(() => vi.mocked(withTenantDb).mockReset());

  it("throws ExecutionNotFoundError when the execution does not exist", async () => {
    setup({ root: null });
    await expect(
      agentTraceGetHandler({ executionId: "aex_missing" }, CTX),
    ).rejects.toThrow("Execution aex_missing not found");
  });

  it("returns the root execution with its fields mapped", async () => {
    setup({ root: exec() });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.executionId).toBe("aex_root");
    expect(out.status).toBe("completed");
    expect(out.originType).toBe("chat");
    expect(out.latencyMs).toBe(4000);
    expect(out.inputTokens).toBe(100);
    expect(out.estimatedCostUsd).toBe("0.012000");
    expect(out.startedAt).toBe("2026-06-16T00:00:00.000Z");
    expect(out.steps).toEqual([]);
    expect(out.children).toEqual([]);
  });

  it("nests steps and their tool calls under the execution", async () => {
    setup({
      root: exec(),
      steps: [
        {
          id: "aesuuid_1",
          publicId: "aes_1",
          executionId: "aexuuid_root",
          stepNumber: 1,
          stepType: "tool_call",
          status: "completed",
          failureReason: null,
          startedAt: new Date("2026-06-16T00:00:01Z"),
          completedAt: new Date("2026-06-16T00:00:02Z"),
          latencyMs: 1000,
          inputTokens: 10,
          outputTokens: 5,
        },
      ],
      tools: [
        {
          id: "atcuuid_1",
          publicId: "atc_1",
          executionStepId: "aesuuid_1",
          toolName: "get_ontology_neighbors",
          toolType: "capability",
          status: "completed",
          latencyMs: 800,
          inputTokens: 4,
          outputTokens: 2,
          requestPayload: { nodeId: "n1" },
          responsePayload: { neighbors: ["a", "b"] },
        },
      ],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.steps).toHaveLength(1);
    const step = out.steps[0]!;
    expect(step.stepId).toBe("aes_1");
    expect(step.toolCalls).toHaveLength(1);
    const tc = step.toolCalls[0]!;
    expect(tc.toolCallId).toBe("atc_1");
    expect(tc.toolName).toBe("get_ontology_neighbors");
    expect(tc.requestBytes).toBeGreaterThan(0);
    expect(tc.responseBytes).toBeGreaterThan(0);
    expect(tc.responsePreview).toContain("neighbors");
  });

  it("nests a child execution under its parent via parent_execution_id", async () => {
    setup({
      root: exec(),
      children: [
        exec({
          id: "aexuuid_child",
          publicId: "aex_child",
          originType: "fanout",
          parentExecutionId: "aexuuid_root",
          status: "running",
        }),
      ],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.children).toHaveLength(1);
    expect(out.children[0]!.executionId).toBe("aex_child");
    expect(out.children[0]!.originType).toBe("fanout");
    expect(out.children[0]!.status).toBe("running");
  });

  it("resolves by UUID when the id is a UUID (no publicId path)", async () => {
    const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    setup({ root: exec({ id: uuid }) });
    const out = await agentTraceGetHandler({ executionId: uuid }, CTX);
    expect(out.executionId).toBe("aex_root");
  });

  it("derives turnMetrics + replayDeterministic from steps via @oxagen/engram", async () => {
    setup({
      root: exec(),
      steps: [
        {
          id: "aesuuid_1",
          publicId: "aes_1",
          executionId: "aexuuid_root",
          stepNumber: 1,
          stepType: "tool_call",
          status: "completed",
          failureReason: null,
          startedAt: new Date("2026-06-16T00:00:01Z"),
          completedAt: new Date("2026-06-16T00:00:02Z"),
          latencyMs: 1000,
          inputTokens: 10,
          outputTokens: 5,
        },
      ],
      tools: [
        {
          id: "atcuuid_1",
          publicId: "atc_1",
          executionStepId: "aesuuid_1",
          toolName: "get_ontology_neighbors",
          toolType: "capability",
          status: "completed",
          latencyMs: 800,
          inputTokens: 4,
          outputTokens: 2,
          requestPayload: {},
          responsePayload: {},
        },
      ],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.turnMetrics).toHaveLength(1);
    const metric = out.turnMetrics![0]!;
    expect(metric.turnId).toBe("aes_1");
    expect(metric.compileMs).toBe(1000);
    expect(metric.tokens).toBe(15); // step's inputTokens(10) + outputTokens(5)
    expect(metric.toolCalls).toBe(1);
    expect(metric.outcome).toBe("success");
    expect(out.replayDeterministic).toBe(true);
  });

  it("does not nest a child whose parent was not collected (root stays root)", async () => {
    // Child references a parent id that is NOT in the collected set.
    setup({
      root: exec(),
      children: [
        exec({
          id: "aexuuid_orphan",
          publicId: "aex_orphan",
          parentExecutionId: "aexuuid_someone_else",
        }),
      ],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    // The orphan is collected (BFS returned it) but not nested under root since
    // its parent isn't root — so root has no children.
    expect(out.children).toHaveLength(0);
  });
});

describe("agent.trace.get handler — payload sizing and previews", () => {
  beforeEach(() => vi.mocked(withTenantDb).mockReset());

  function stepRow(over: Partial<StepRow> = {}): StepRow {
    return {
      id: "aesuuid_1",
      publicId: "aes_1",
      executionId: "aexuuid_root",
      stepNumber: 1,
      stepType: "tool_call",
      status: "completed",
      failureReason: null,
      startedAt: null,
      completedAt: null,
      latencyMs: 100,
      inputTokens: null,
      outputTokens: null,
      ...over,
    };
  }

  function toolRow(over: Partial<ToolRow> = {}): ToolRow {
    return {
      id: "atcuuid_1",
      publicId: "atc_1",
      executionStepId: "aesuuid_1",
      toolName: "get_ontology_neighbors",
      toolType: "capability",
      status: "completed",
      latencyMs: 5,
      inputTokens: null,
      outputTokens: null,
      requestPayload: null,
      responsePayload: null,
      ...over,
    };
  }

  it("reports zero bytes and a null preview for absent payloads", async () => {
    setup({
      root: exec(),
      steps: [stepRow()],
      tools: [toolRow({ requestPayload: null, responsePayload: undefined })],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    const call = out.steps[0]!.toolCalls[0]!;
    expect(call.requestBytes).toBe(0);
    expect(call.responseBytes).toBe(0);
    expect(call.responsePreview).toBeNull();
    // Null timestamps on a step stay null rather than becoming "Invalid Date".
    expect(out.steps[0]!.startedAt).toBeNull();
    expect(out.steps[0]!.completedAt).toBeNull();
  });

  it("degrades to zero bytes and a null preview for an unserializable payload", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    setup({
      root: exec(),
      steps: [stepRow()],
      tools: [toolRow({ requestPayload: circular, responsePayload: circular })],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    const call = out.steps[0]!.toolCalls[0]!;
    expect(call.requestBytes).toBe(0);
    expect(call.responseBytes).toBe(0);
    expect(call.responsePreview).toBeNull();
  });

  it("truncates an oversized response preview with an ellipsis", async () => {
    setup({
      root: exec(),
      steps: [stepRow()],
      tools: [toolRow({ responsePayload: { blob: "x".repeat(900) } })],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    const preview = out.steps[0]!.toolCalls[0]!.responsePreview!;
    expect(preview).toHaveLength(501); // 500 chars + the ellipsis
    expect(preview.endsWith("…")).toBe(true);
  });

  it("leaves a step's toolCalls empty when no call references it", async () => {
    setup({
      root: exec(),
      steps: [stepRow()],
      tools: [toolRow({ executionStepId: "aesuuid_other" })],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.steps[0]!.toolCalls).toEqual([]);
  });

  it("maps null execution timestamps to null", async () => {
    setup({ root: exec({ startedAt: null, completedAt: null }) });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.startedAt).toBeNull();
    expect(out.completedAt).toBeNull();
  });
});

describe("agent.trace.get handler — turn metrics", () => {
  beforeEach(() => vi.mocked(withTenantDb).mockReset());

  function step(over: Partial<StepRow>): StepRow {
    return {
      id: `aesuuid_${over.publicId ?? "x"}`,
      publicId: "aes_x",
      executionId: "aexuuid_root",
      stepNumber: 1,
      stepType: "tool_call",
      status: "completed",
      failureReason: null,
      startedAt: null,
      completedAt: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      ...over,
    };
  }

  it("derives one turn per step and classifies each outcome", async () => {
    setup({
      root: exec(),
      steps: [
        step({
          publicId: "aes_ok",
          status: "completed",
          inputTokens: 3,
          outputTokens: 4,
          latencyMs: 11,
        }),
        step({ publicId: "aes_fail", stepNumber: 2, status: "failed" }),
        step({ publicId: "aes_run", stepNumber: 3, status: "running" }),
      ],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.turnMetrics).toEqual([
      {
        turnId: "aes_ok",
        compileMs: 11,
        tokens: 7,
        cacheHitRate: 0,
        toolCalls: 0,
        outcome: "success",
      },
      // Null token counts fall back to 0; a null latency to 0 compileMs.
      {
        turnId: "aes_fail",
        compileMs: 0,
        tokens: 0,
        cacheHitRate: 0,
        toolCalls: 0,
        outcome: "failure",
      },
      {
        turnId: "aes_run",
        compileMs: 0,
        tokens: 0,
        cacheHitRate: 0,
        toolCalls: 0,
        outcome: "interrupted",
      },
    ]);
    expect(out.replayDeterministic).toBe(true);
  });

  it("flags the trace as non-deterministic when a turn reports negative tokens", async () => {
    setup({
      root: exec(),
      steps: [step({ publicId: "aes_bad", inputTokens: -5, outputTokens: 1 })],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.replayDeterministic).toBe(false);
  });
});
