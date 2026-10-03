import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: vi.fn() };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { withTenantDb } from "@oxagen/database";
import { createOxagenAssistantBinding } from "@oxagen/oxagen/oxagen-assistant";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentTraceGetHandler } from "./agent.trace.get";
import { ExecutionNotFoundError } from "./execution-errors";
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

  it("derives turnMetrics + metricsInRange from the stored steps", async () => {
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
    expect(out.metricsInRange).toBe(true);
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
    expect(out.metricsInRange).toBe(true);
  });

  it("flags the metrics as out of range when a turn reports negative tokens", async () => {
    setup({
      root: exec(),
      steps: [step({ publicId: "aes_bad", inputTokens: -5, outputTokens: 1 })],
    });
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.metricsInRange).toBe(false);
  });
});

// ADR-235: each turn of the in-app assistant records an execution under the
// workspace's managed `interactive_chat` agent. That record is internal, so
// only the assistant itself reads it back.
describe("agent.trace.get handler: the in-app assistant's executions", () => {
  beforeEach(() => vi.mocked(withTenantDb).mockReset());

  const dialect = new PgDialect();
  /** The NOT EXISTS test the handler adds, as the dialect renders it. */
  const EXCLUSION =
    /not exists \(select 1 from "agent"\."agents" where "agent"\."agents"\."id" = "agent"\."agent_executions"\."agent_id" and "agent"\."agents"\."agent_type" = \$(\d+)\)/u;

  /** The OR the assistant's own call adds: the person who asked, as a param. */
  const OWN = /"own_conversation"\."user_id" = \$(\d+)\)/u;

  type TypedExec = ExecRow & { agentType: string | null; askedBy?: string };

  /** True when the rendered WHERE leaves `interactive_chat` agents out. */
  function hidesAssistant(rendered: { sql: string; params: unknown[] }) {
    const match = EXCLUSION.exec(rendered.sql);
    return (
      match !== null &&
      rendered.params[Number(match[1]) - 1] === "interactive_chat"
    );
  }

  /** The person whose own assistant rows the WHERE keeps, if it keeps any. */
  function askerOf(rendered: { sql: string; params: unknown[] }) {
    const own = OWN.exec(rendered.sql);
    return own === null ? undefined : rendered.params[Number(own[1]) - 1];
  }

  /**
   * Like `setup`, but the execution reads render the WHERE they receive and
   * apply the exclusion the way Postgres would. Steps and tool calls are
   * empty.
   */
  function setupRendering(root: TypedExec, children: TypedExec[] = []) {
    const wheres: Array<{ sql: string; params: unknown[] }> = [];
    const visible = (rows: TypedExec[], hides: boolean, asker: unknown) =>
      rows
        .filter(
          (r) =>
            !(
              hides &&
              r.agentType === "interactive_chat" &&
              (asker === undefined || r.askedBy !== asker)
            ),
        )
        .map(({ agentType: _agentType, askedBy: _askedBy, ...r }) => r);
    let dbCall = 0;
    vi.mocked(withTenantDb).mockImplementation((fn) => {
      if (typeof fn !== "function") return undefined as never;
      const call = dbCall;
      dbCall += 1;
      let childBatchServed = false;
      const tx = {
        select: () => ({
          from: () => ({
            where: (cond: SQL) => {
              if (call > 0) return { orderBy: () => Promise.resolve([]) };
              const rendered = dialect.sqlToQuery(cond);
              wheres.push(rendered);
              const hides = hidesAssistant(rendered);
              const asker = askerOf(rendered);
              return {
                limit: () => Promise.resolve(visible([root], hides, asker)),
                orderBy: () => {
                  if (childBatchServed) return Promise.resolve([]);
                  childBatchServed = true;
                  return Promise.resolve(visible(children, hides, asker));
                },
              };
            },
          }),
        }),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });
    return wheres;
  }

  const ASSISTANT_AGENT = "00000000-0000-4000-8000-0000000000a1";
  const assistantExec = (askedBy: string = CTX.userId!): TypedExec => ({
    ...exec({
      id: "aexuuid_assistant",
      publicId: "aex_assistant",
      agentId: ASSISTANT_AGENT,
    }),
    agentType: "interactive_chat",
    askedBy,
  });
  const withBinding = () => ({
    ...CTX,
    oxagenAssistant: createOxagenAssistantBinding({
      requestId: CTX.requestId,
    }),
  });

  it("answers as not found when a caller without the binding asks for the assistant's execution", async () => {
    const wheres = setupRendering(assistantExec());
    await expect(
      agentTraceGetHandler({ executionId: "aex_assistant" }, CTX),
    ).rejects.toBeInstanceOf(ExecutionNotFoundError);
    expect(wheres[0]!.sql).toMatch(EXCLUSION);
    expect(wheres[0]!.params).toContain("interactive_chat");
  });

  it("returns the assistant the asker's own execution when the call carries its binding", async () => {
    const wheres = setupRendering(assistantExec());
    const out = await agentTraceGetHandler(
      { executionId: "aex_assistant" },
      withBinding(),
    );
    expect(out.executionId).toBe("aex_assistant");
    for (const where of wheres) {
      expect(where.sql).toMatch(OWN);
      expect(where.params).toContain(CTX.userId);
    }
  });

  it("answers as not found when the assistant asks for another person's execution (negative)", async () => {
    setupRendering(assistantExec("u_2"));
    await expect(
      agentTraceGetHandler({ executionId: "aex_assistant" }, withBinding()),
    ).rejects.toBeInstanceOf(ExecutionNotFoundError);
  });

  it("leaves an assistant execution out of another execution's tree", async () => {
    const wheres = setupRendering({ ...exec(), agentType: "custom" }, [
      {
        ...assistantExec(),
        parentExecutionId: "aexuuid_root",
      },
      {
        ...exec({
          id: "aexuuid_child",
          publicId: "aex_child",
          parentExecutionId: "aexuuid_root",
        }),
        agentType: null,
      },
    ]);
    const out = await agentTraceGetHandler({ executionId: "aex_root" }, CTX);
    expect(out.children.map((c) => c.executionId)).toEqual(["aex_child"]);
    // The root read and the first child read both carry the exclusion.
    expect(wheres.length).toBeGreaterThanOrEqual(2);
    for (const where of wheres) expect(where.sql).toMatch(EXCLUSION);
  });
});
