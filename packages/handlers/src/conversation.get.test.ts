import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@oxagen/database";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { conversationGet } from "@oxagen/oxagen/contracts/conversation.get";
import type { RunToolCallRecord } from "@oxagen/run-ledger";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  apiKeyCreator: vi.fn((): string | null => null),
  readToolCallsForRuns: vi.fn(
    async (
      _runPublicIds: readonly string[],
    ): Promise<ReadonlyMap<string, RunToolCallRecord[]>> => new Map(),
  ),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a suite that counts seam calls must see one identity.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// resolveActingUserId is org-role.ts's own key-to-creator read; the fake
// answers the session user, else the creator of the key.
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: {
    userId: string | null;
    apiKeyId: string | null;
  }) => ctx.userId ?? (ctx.apiKeyId ? mocks.apiKeyCreator() : null),
}));

import { createConversationGetHandler } from "./conversation.get";
import { makeCTX } from "./test-utils/fixtures";

const dialect = new PgDialect();
const CONVERSATIONS = getTableName(schema.conversations);
const MESSAGES = getTableName(schema.messages);

interface Read {
  table: string;
  where: string;
  params: unknown[];
}

const CONVERSATION_ROW = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000c1",
  publicId: "cnv_01k9x2",
  title: null,
  status: "active",
  archivedAt: null,
  createdAt: new Date("2026-09-25T09:59:00.000Z"),
  updatedAt: new Date("2026-09-25T10:03:00.000Z"),
  activeLeafMessageId: "m4",
};

const at = (minute: number) =>
  new Date(`2026-09-25T10:0${String(minute)}:00.000Z`);

const CARD = {
  approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
  capability: "set_budget",
  expiresAt: "2026-09-25T10:08:00.000Z",
};

// Two turns as ask_assistant writes them: no parent links, the run and the
// parked writes on the reply's metadata.
const MESSAGE_ROWS = [
  {
    id: "m1",
    publicId: "msg_a1",
    parentMessageId: null,
    role: "user",
    content: "what is live?",
    metadata: { surface: "chat" },
    createdAt: at(0),
  },
  {
    id: "m2",
    publicId: "msg_a2",
    parentMessageId: null,
    role: "assistant",
    content: "Three runs are live.",
    metadata: { status: "complete", surface: "chat", runId: "arun_0001" },
    createdAt: at(1),
  },
  {
    id: "m3",
    publicId: "msg_a3",
    parentMessageId: null,
    role: "user",
    content: "raise the budget",
    metadata: { surface: "chat" },
    createdAt: at(2),
  },
  {
    id: "m4",
    publicId: "msg_a4",
    parentMessageId: null,
    role: "assistant",
    content: "That write waits on a person.",
    metadata: {
      status: "complete",
      surface: "chat",
      runId: "arun_0002",
      parkedCards: [CARD, { approvalId: 7 }],
    },
    createdAt: at(3),
  },
];

/**
 * A transaction that answers the conversation read from `conversations` and
 * the message read from `messages`, and records each read's WHERE clause.
 */
function run(
  input: { conversationId: string | null; limit?: number },
  answers: { conversations?: unknown[]; messages?: unknown[] },
  ctx: CapabilityContext = makeCTX(),
) {
  const reads: Read[] = [];
  const tx = {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: (cond: SQL) => {
          const name = getTableName(table);
          const q = dialect.sqlToQuery(cond);
          reads.push({ table: name, where: q.sql, params: q.params });
          const rows =
            name === CONVERSATIONS
              ? (answers.conversations ?? [])
              : (answers.messages ?? []);
          return {
            orderBy: () => ({
              limit: () => Promise.resolve(rows),
              then: (resolve: (v: unknown) => unknown) => resolve(rows),
            }),
          };
        },
      }),
    }),
  };
  mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
    Promise.resolve(fn(tx)),
  );
  const handler = createConversationGetHandler({
    readToolCallsForRuns: mocks.readToolCallsForRuns,
  });
  return {
    reads,
    out: handler(
      { conversationId: input.conversationId, limit: input.limit ?? 100 },
      ctx,
    ),
  };
}

/** One tool call as the run ledger reads it back. */
function ledgerCall(
  runSeq: string,
  over: Partial<RunToolCallRecord> = {},
): RunToolCallRecord {
  return {
    runSeq,
    toolCallId: `tc-${runSeq}`,
    toolName: "list_runs",
    outcome: "completed",
    durationMs: 40,
    approvalPublicId: null,
    ...over,
  };
}

// The ledger as the two replies' runs recorded them: one read on the first,
// a read and a parked write on the second.
const LEDGER = new Map<string, RunToolCallRecord[]>([
  ["arun_0001", [ledgerCall("3")]],
  [
    "arun_0002",
    [
      ledgerCall("4", { toolName: "get_budget", durationMs: 12 }),
      ledgerCall("6", {
        toolName: "set_budget",
        outcome: "parked",
        durationMs: 88,
        approvalPublicId: CARD.approvalId,
      }),
    ],
  ],
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiKeyCreator.mockReturnValue(null);
  mocks.readToolCallsForRuns.mockImplementation(async () => new Map());
});

describe("get_conversation", () => {
  it("reads the person's latest active conversation with every turn, in the order it was written", async () => {
    const { reads, out } = run(
      { conversationId: null },
      { conversations: [CONVERSATION_ROW], messages: MESSAGE_ROWS },
    );
    const { conversation } = await out;
    expect(conversation?.publicId).toBe("cnv_01k9x2");
    expect(conversation?.messages.map((m) => m.content)).toEqual([
      "what is live?",
      "Three runs are live.",
      "raise the budget",
      "That write waits on a person.",
    ]);
    expect(conversation?.truncated).toBe(false);
    // The latest thread is an active one: archived rows are not reopened.
    const where = reads[0]?.where ?? "";
    expect(reads[0]?.table).toBe(CONVERSATIONS);
    expect(where).toMatch(/"archived_at" is null/);
    expect(where).not.toMatch(/"public_id"/);
  });

  it("carries the run each reply was recorded as and the writes it parked", async () => {
    const { out } = run(
      { conversationId: "cnv_01k9x2" },
      { conversations: [CONVERSATION_ROW], messages: MESSAGE_ROWS },
    );
    const messages = (await out).conversation?.messages ?? [];
    expect(messages.map((m) => m.runId)).toEqual([
      null,
      "arun_0001",
      null,
      "arun_0002",
    ]);
    // The malformed stored card is dropped, and the rest of the thread stays.
    expect(messages[3]?.parkedCards).toEqual([CARD]);
    expect(messages[0]?.parkedCards).toEqual([]);
    expect(messages[3]?.publicId).toBe("msg_a4");
  });

  it("marks a reply the person stopped, and no other message", async () => {
    const stopped = {
      id: "m5",
      publicId: "msg_a5",
      parentMessageId: null,
      role: "assistant",
      content: "Two runs are",
      // The literal, not ASSISTANT_MESSAGE_STOPPED: saved rows carry this
      // string, so the reader must keep reading it.
      metadata: { status: "stopped", surface: "chat", runId: "arun_0003" },
      createdAt: at(4),
    };
    const { out } = run(
      { conversationId: "cnv_01k9x2" },
      {
        conversations: [CONVERSATION_ROW],
        messages: [...MESSAGE_ROWS, stopped],
      },
    );
    const messages = (await out).conversation?.messages ?? [];
    expect(messages.map((m) => m.stopped)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(messages[4]?.content).toBe("Two runs are");
  });

  // The ownership rule the other conversation handlers apply: this org and
  // workspace, the person asking, not deleted.
  it("reads only the caller's own conversation, and never a deleted one", async () => {
    const { reads, out } = run(
      { conversationId: "cnv_01k9x2" },
      { conversations: [CONVERSATION_ROW], messages: [] },
    );
    await out;
    const read = reads[0];
    expect(read?.where).toMatch(/"org_id" = \$/);
    expect(read?.where).toMatch(/"workspace_id" = \$/);
    expect(read?.where).toMatch(/"user_id" = \$/);
    expect(read?.where).toMatch(/"deleted_at" is null/);
    expect(read?.where).toMatch(/"public_id" = \$/);
    expect(read?.params).toEqual(
      expect.arrayContaining(["org_1", "ws_1", "u_1", "cnv_01k9x2"]),
    );
    // A named conversation of your own can be read after you archive it.
    expect(read?.where).not.toMatch(/"archived_at"/);
    // The messages are read inside the same tenant fence.
    expect(reads[1]?.table).toBe(MESSAGES);
    expect(reads[1]?.where).toMatch(/"org_id" = \$/);
    expect(reads[1]?.where).toMatch(/"workspace_id" = \$/);
  });

  it("refuses a conversation that is not the caller's, deleted or missing as not_found (negative)", async () => {
    const { out } = run({ conversationId: "cnv_01k9zz" }, {});
    const err = await out.catch((e: unknown) => e);
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "not_found",
      reason: "conversation_not_found",
    });
  });

  it("answers null when the person has no active conversation yet", async () => {
    const { reads, out } = run({ conversationId: null }, {});
    await expect(out).resolves.toEqual({ conversation: null });
    // No message read for a conversation that does not exist.
    expect(reads).toHaveLength(1);
  });

  it("returns the newest messages up to the limit and says it left earlier ones out", async () => {
    const { out } = run(
      { conversationId: null, limit: 2 },
      { conversations: [CONVERSATION_ROW], messages: MESSAGE_ROWS },
    );
    const { conversation } = await out;
    expect(conversation?.messages.map((m) => m.publicId)).toEqual([
      "msg_a3",
      "msg_a4",
    ]);
    expect(conversation?.truncated).toBe(true);
  });

  it("leaves out a row whose role no thread carries", async () => {
    const tool = {
      ...MESSAGE_ROWS[0],
      id: "m9",
      publicId: "msg_t9",
      role: "tool",
      createdAt: at(4),
    };
    const { out } = run(
      { conversationId: null },
      { conversations: [CONVERSATION_ROW], messages: [...MESSAGE_ROWS, tool] },
    );
    const messages = (await out).conversation?.messages ?? [];
    expect(messages.map((m) => m.publicId)).not.toContain("msg_t9");
    expect(messages).toHaveLength(4);
  });

  it("lists each reply's tool calls from its run, read from the ledger once for the thread", async () => {
    mocks.readToolCallsForRuns.mockImplementation(async () => LEDGER);
    const { out } = run(
      { conversationId: null },
      { conversations: [CONVERSATION_ROW], messages: MESSAGE_ROWS },
    );
    const result = await out;
    const messages = result.conversation?.messages ?? [];
    expect(mocks.readToolCallsForRuns).toHaveBeenCalledTimes(1);
    expect(mocks.readToolCallsForRuns).toHaveBeenCalledWith([
      "arun_0001",
      "arun_0002",
    ]);
    expect(messages[1]?.toolCalls).toEqual([
      {
        toolCallId: "tc-3",
        toolName: "list_runs",
        outcome: "completed",
        durationMs: 40,
        approvalId: null,
      },
    ]);
    // The parked write points at the same approval as the reply's card.
    expect(messages[3]?.toolCalls).toEqual([
      {
        toolCallId: "tc-4",
        toolName: "get_budget",
        outcome: "completed",
        durationMs: 12,
        approvalId: null,
      },
      {
        toolCallId: "tc-6",
        toolName: "set_budget",
        outcome: "parked",
        durationMs: 88,
        approvalId: CARD.approvalId,
      },
    ]);
    expect(messages[3]?.parkedCards[0]?.approvalId).toBe(CARD.approvalId);
    // A person's message never lists calls.
    expect(messages[0]?.toolCalls).toEqual([]);
    expect(messages[2]?.toolCalls).toEqual([]);
    // The answer is one the contract accepts.
    expect(() => conversationGet.output.parse(result)).not.toThrow();
  });

  it("reads only the runs of the replies it returns", async () => {
    mocks.readToolCallsForRuns.mockImplementation(async () => LEDGER);
    const { out } = run(
      { conversationId: null, limit: 1 },
      { conversations: [CONVERSATION_ROW], messages: MESSAGE_ROWS },
    );
    const messages = (await out).conversation?.messages ?? [];
    expect(mocks.readToolCallsForRuns).toHaveBeenCalledWith(["arun_0002"]);
    expect(messages.map((m) => m.toolCalls.length)).toEqual([2]);
  });

  it("asks the ledger for a run once when two replies share it", async () => {
    const second = {
      ...MESSAGE_ROWS[1],
      id: "m5",
      publicId: "msg_a5",
      content: "And one more.",
      createdAt: at(4),
    };
    const { out } = run(
      { conversationId: null },
      {
        conversations: [CONVERSATION_ROW],
        messages: [...MESSAGE_ROWS, second],
      },
    );
    await out;
    expect(mocks.readToolCallsForRuns).toHaveBeenCalledWith([
      "arun_0001",
      "arun_0002",
    ]);
  });

  it("does not read the ledger when no reply returned was recorded as a run", async () => {
    const [ask, reply] = MESSAGE_ROWS;
    const unrecorded = { ...reply, metadata: { status: "complete" } };
    const { out } = run(
      { conversationId: null },
      { conversations: [CONVERSATION_ROW], messages: [ask, unrecorded] },
    );
    const messages = (await out).conversation?.messages ?? [];
    expect(mocks.readToolCallsForRuns).not.toHaveBeenCalled();
    expect(messages.map((m) => m.toolCalls)).toEqual([[], []]);
  });

  it("lists no calls for a reply whose run the ledger holds none for", async () => {
    mocks.readToolCallsForRuns.mockImplementation(
      async () => new Map([["arun_0001", [ledgerCall("3")]]]),
    );
    const { out } = run(
      { conversationId: null },
      { conversations: [CONVERSATION_ROW], messages: MESSAGE_ROWS },
    );
    const messages = (await out).conversation?.messages ?? [];
    expect(messages[1]?.toolCalls).toHaveLength(1);
    expect(messages[3]?.toolCalls).toEqual([]);
  });

  it("still returns the thread when the ledger read fails, with no calls on any reply (negative)", async () => {
    mocks.readToolCallsForRuns.mockImplementation(async () => {
      throw new Error("ledger unavailable");
    });
    const { out } = run(
      { conversationId: null },
      { conversations: [CONVERSATION_ROW], messages: MESSAGE_ROWS },
    );
    const messages = (await out).conversation?.messages ?? [];
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.toolCalls)).toEqual([[], [], [], []]);
    expect(messages[3]?.parkedCards).toEqual([CARD]);
  });

  it("reads an API key's conversations as the person who created the key", async () => {
    mocks.apiKeyCreator.mockReturnValue("u_creator");
    const { reads, out } = run(
      { conversationId: null },
      { conversations: [] },
      makeCTX({ userId: null, apiKeyId: "key_1" }),
    );
    await out;
    expect(reads[0]?.params).toContain("u_creator");
  });

  it("refuses a caller with no person to read as (negative)", async () => {
    const { out } = run(
      { conversationId: null },
      {},
      makeCTX({ userId: null, apiKeyId: null }),
    );
    await expect(out).rejects.toMatchObject({
      code: "forbidden",
      reason: "no_principal",
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
