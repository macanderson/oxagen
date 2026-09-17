/**
 * get_message_execution: the agent-execution record a chat turn leaves behind
 * (SOC 2 CC6/CC7) and the message metadata that links to it. Every store is a
 * fake; what is under test is which rows are written and what the message's
 * metadata looks like afterwards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  project: vi.fn(),
  inserts: [] as Array<{ table: unknown; values: unknown }>,
  updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
}));

vi.mock("./project-tool-usage", () => ({
  projectToolUsageBestEffort: mocks.project,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    query: { messages: { findFirst: mocks.findFirst } },
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        mocks.inserts.push({ table, values });
        const rows = Array.isArray(values) ? values : [values];
        return {
          returning: () =>
            Promise.resolve(
              rows.map((_, i) => ({
                id:
                  table === real.schema.agentExecutions ? EXEC_ID : `step-${i}`,
                createdAt: CREATED_AT,
              })),
            ),
          then: (res: (v: unknown) => unknown) => Promise.resolve().then(res),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        mocks.updates.push({ table, set });
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return {
    ...real,
    withTenantDb: (fn: (t: unknown) => unknown) => Promise.resolve(fn(tx)),
  };
});

import { chatMessageExecutionHandler } from "./chat.message.execution";
import { makeCTX } from "./test-utils/fixtures";

const EXEC_ID = "0192d4a8-7c1e-7a00-8000-0000000000e1";
const MESSAGE_ID = "0192d4a8-7c1e-7a00-8000-0000000000d2";
const AGENT_ID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const AGENT_VERSION_ID = "0192d4a8-7c1e-7a00-8000-0000000000a2";
const CREATED_AT = new Date("2026-09-16T10:00:00.000Z");
const CTX = makeCTX({ userId: "u_1" });

const INPUT = {
  messageId: MESSAGE_ID,
  agentId: AGENT_ID,
  agentVersionId: AGENT_VERSION_ID,
  originType: "chat" as const,
  originId: MESSAGE_ID,
  status: "completed" as const,
  inputPayload: { content: "what did my agents do" },
  updateMessageMetadata: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserts.length = 0;
  mocks.updates.length = 0;
  mocks.findFirst.mockResolvedValue({
    id: MESSAGE_ID,
    conversationId: "conv-1",
    metadata: { status: "complete", surface: "chat", runId: "arun_abc" },
  });
});

describe("get_message_execution", () => {
  it("writes the execution row and projects the tool-usage lineage", async () => {
    const out = await chatMessageExecutionHandler(INPUT, CTX);
    expect(out).toMatchObject({ executionId: EXEC_ID, status: "completed" });
    expect(
      mocks.inserts.find((i) => i.table === schema.agentExecutions)?.values,
    ).toMatchObject({ agentId: AGENT_ID, originType: "chat" });
    expect(mocks.project).toHaveBeenCalledWith(EXEC_ID, CTX);
  });

  // The turn stamped `surface` and the `arun_…` run id on this message before
  // the execution existed. Replacing the metadata object would take the link
  // to the run away in the act of recording the execution.
  it("merges into the message metadata rather than replacing it", async () => {
    await chatMessageExecutionHandler(INPUT, CTX);
    const update = mocks.updates.find((u) => u.table === schema.messages);
    expect(update?.set.metadata).toEqual({
      status: "completed",
      surface: "chat",
      runId: "arun_abc",
      executionId: EXEC_ID,
      completedAt: CREATED_AT,
    });
  });

  it("writes metadata from nothing when the message carried none", async () => {
    mocks.findFirst.mockResolvedValue({
      id: MESSAGE_ID,
      conversationId: "conv-1",
      metadata: null,
    });
    await chatMessageExecutionHandler(INPUT, CTX);
    expect(
      mocks.updates.find((u) => u.table === schema.messages)?.set.metadata,
    ).toEqual({
      status: "completed",
      executionId: EXEC_ID,
      completedAt: CREATED_AT,
    });
  });

  it("leaves the message alone when the caller did not ask for the link (negative)", async () => {
    await chatMessageExecutionHandler(
      { ...INPUT, updateMessageMetadata: false },
      CTX,
    );
    expect(
      mocks.updates.find((u) => u.table === schema.messages),
    ).toBeUndefined();
  });

  it("writes steps and their tool calls, aligned by position", async () => {
    await chatMessageExecutionHandler(
      {
        ...INPUT,
        steps: [
          {
            stepNumber: 1,
            stepType: "llm_turn",
            status: "completed" as const,
            inputPayload: { model: "claude" },
            toolCalls: [
              {
                toolName: "recall_memory",
                toolType: "capability",
                requestPayload: { query: "runs" },
                status: "completed" as const,
              },
            ],
          },
        ],
      },
      CTX,
    );
    const steps = mocks.inserts.find(
      (i) => i.table === schema.agentExecutionSteps,
    )?.values as unknown[];
    expect(steps).toHaveLength(1);
    const toolCalls = mocks.inserts.find(
      (i) => i.table === schema.agentToolCalls,
    )?.values as Array<{ executionStepId: string; toolName: string }>;
    expect(toolCalls).toEqual([
      expect.objectContaining({
        executionStepId: "step-0",
        toolName: "recall_memory",
      }),
    ]);
  });

  it("refuses a message outside the calling workspace (negative)", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(chatMessageExecutionHandler(INPUT, CTX)).rejects.toThrow(
      /message not found/,
    );
    expect(mocks.inserts).toHaveLength(0);
    expect(mocks.project).not.toHaveBeenCalled();
  });
});
