// record_reply_feedback over a fake tenant transaction and a mocked ClickHouse
// writer. The transaction answers each of the handler's three reads (the run,
// the conversation, the reply) from the table it was asked about, and keeps
// each WHERE clause so the test can read the SQL the handler sent. The role
// gate is mocked the way cost.price_entry.set.test.ts mocks it: these tests
// are about what the handler checks and writes, and role-check.test.ts pins
// that the gate is called at all.
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import {
  clearBillingAdmissionGate,
  clearHandlersForTests,
  clearKernelIAMRuntime,
  clearSecurityEventEmitter,
  invoke,
  registerHandler,
} from "@oxagen/oxagen/kernel";
import {
  assistantReplyFeedbackRecord,
  REPLY_FEEDBACK_NOTE_MAX_CHARS,
} from "@oxagen/oxagen/contracts/assistant.reply_feedback.record";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  recordReplyFeedback: vi.fn(async (_row: unknown) => undefined),
  roleRefused: false,
  keyCreator: null as string | null,
  actors: [] as (string | null)[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant seam
  // (ADR-086), as every handler suite here does.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/telemetry", () => ({
  recordReplyFeedback: mocks.recordReplyFeedback,
}));

vi.mock("@oxagen/iam/org-role", async () => {
  const { HandlerError } = await import("@oxagen/oxagen");
  return {
    resolveActingUserId: async (c: {
      userId: string | null;
      apiKeyId: string | null;
    }) => c.userId ?? (c.apiKeyId ? mocks.keyCreator : null),
    assertOrgRole: async (actor: { userId: string | null }) => {
      mocks.actors.push(actor.userId);
      if (mocks.roleRefused)
        throw new HandlerError({
          code: "forbidden",
          reason: "org_role_required",
        });
      return "Member";
    },
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schema } from "@oxagen/database";
import { assistantReplyFeedbackRecordHandler } from "./assistant.reply_feedback.record";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const PERSON = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const CONVERSATION = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const MESSAGE = "0192d4a8-7c1e-7a00-8000-0000000000d2";
const RUN = "arun_0123456789abcdef012345";

const CTX: CapabilityContext = {
  orgId: ORG,
  workspaceId: WS,
  userId: PERSON,
  apiKeyId: null,
  requestId: "req_1",
  surface: "app",
  messageId: null,
};

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

/** What each of the three reads finds. Null is "no row". */
interface Store {
  run: { id: string } | null;
  conversation: { id: string } | null;
  message: { id: string } | null;
}

/** The WHERE clause each read sent, keyed by the table it read. */
type Seen = Partial<Record<"run" | "conversation" | "message", SQL>>;

function setup(over: Partial<Store> = {}): Seen {
  const store: Store = {
    run: { id: "0192d4a8-7c1e-7a00-8000-0000000000a1" },
    conversation: { id: CONVERSATION },
    message: { id: MESSAGE },
    ...over,
  };
  const seen: Seen = {};
  const keyOf = (table: unknown): keyof Store => {
    if (table === schema.agentRuns) return "run";
    if (table === schema.conversations) return "conversation";
    if (table === schema.messages) return "message";
    throw new Error("the handler read a table this test does not expect");
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: (where: SQL) => ({
          limit: async () => {
            const key = keyOf(table);
            seen[key] = where;
            const row = store[key];
            return row === null ? [] : [row];
          },
        }),
      }),
    }),
  };
  mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
    Promise.resolve(fn(tx)),
  );
  return seen;
}

const notFound = (e: unknown) =>
  isHandlerError(e) &&
  e.code === "not_found" &&
  e.reason === "assistant_reply_not_found";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roleRefused = false;
  mocks.keyCreator = null;
  mocks.actors = [];
});

describe("record_reply_feedback: the row it writes", () => {
  it("appends one row keyed by the run, the reply the run wrote, and the voter", async () => {
    setup();
    const out = await assistantReplyFeedbackRecordHandler(
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "wrong",
        note: "It named the wrong agent.",
      },
      CTX,
    );

    expect(mocks.recordReplyFeedback).toHaveBeenCalledTimes(1);
    const row = mocks.recordReplyFeedback.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(row).toEqual({
      run_public_id: RUN,
      conversation_id: CONVERSATION,
      message_id: MESSAGE,
      user_id: PERSON,
      verdict: "wrong",
      note: "It named the wrong agent.",
      created_at: out.recordedAt,
    });
    // The tenant columns are the seam's to stamp from the scope.
    expect(row).not.toHaveProperty("org_id");
    expect(row).not.toHaveProperty("workspace_id");
    expect(out).toEqual({
      runId: RUN,
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      verdict: "wrong",
      note: "It named the wrong agent.",
      recordedAt: out.recordedAt,
    });
    expect(assistantReplyFeedbackRecord.output.parse(out)).toEqual(out);
  });

  it("writes an empty note for none, and answers null", async () => {
    setup();
    const out = await assistantReplyFeedbackRecordHandler(
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "useful",
        note: null,
      },
      CTX,
    );
    expect(mocks.recordReplyFeedback.mock.calls[0]![0]).toMatchObject({
      verdict: "useful",
      note: "",
    });
    expect(out.note).toBeNull();
  });

  it("votes as the key's creator on an API-key call", async () => {
    mocks.keyCreator = "0192d4a8-7c1e-7a00-8000-0000000005e2";
    const seen = setup();
    await assistantReplyFeedbackRecordHandler(
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "useful",
        note: null,
      },
      { ...CTX, userId: null, apiKeyId: "key_1" },
    );
    expect(mocks.actors).toEqual(["0192d4a8-7c1e-7a00-8000-0000000005e2"]);
    expect(render(seen.conversation!).params).toContain(
      "0192d4a8-7c1e-7a00-8000-0000000005e2",
    );
    expect(mocks.recordReplyFeedback.mock.calls[0]![0]).toMatchObject({
      user_id: "0192d4a8-7c1e-7a00-8000-0000000005e2",
    });
  });
});

describe("record_reply_feedback: what it checks before writing", () => {
  it("reads the run as an in-app assistant run in this workspace", async () => {
    const seen = setup();
    await assistantReplyFeedbackRecordHandler(
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "useful",
        note: null,
      },
      CTX,
    );
    const run = render(seen.run!);
    expect(run.sql).toContain('"public_id" = $1');
    expect(run.sql).toContain('"surface" in ($4, $5)');
    expect(run.params).toEqual([RUN, ORG, WS, "chat", "api-chat"]);
  });

  it("reads the conversation as the caller's own, not deleted, and the reply by its run", async () => {
    const seen = setup();
    await assistantReplyFeedbackRecordHandler(
      {
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "useful",
        note: null,
      },
      CTX,
    );
    const conversation = render(seen.conversation!);
    expect(conversation.sql).toContain('"user_id" = $4');
    expect(conversation.sql).toContain('"deleted_at" is null');
    expect(conversation.params).toEqual([CONVERSATION, ORG, WS, PERSON]);

    const message = render(seen.message!);
    expect(message.sql).toContain('"role" = $4');
    expect(message.sql).toContain("->>'runId' = $5");
    expect(message.params).toEqual([
      CONVERSATION,
      ORG,
      WS,
      "assistant",
      RUN,
    ]);
  });

  it("refuses a run in someone else's conversation, and writes nothing", async () => {
    // The conversation read is fenced on the caller's user id, so another
    // person's conversation reads as no row.
    const seen = setup({ conversation: null });
    await expect(
      assistantReplyFeedbackRecordHandler(
        {
          conversationId: CONVERSATION,
          runId: RUN,
          verdict: "wrong",
          note: null,
        },
        CTX,
      ),
    ).rejects.toSatisfy(notFound);
    expect(render(seen.conversation!).params).toContain(PERSON);
    expect(seen.message).toBeUndefined();
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
  });

  it("refuses a run that is not an assistant run in this workspace", async () => {
    const seen = setup({ run: null });
    await expect(
      assistantReplyFeedbackRecordHandler(
        {
          conversationId: CONVERSATION,
          runId: RUN,
          verdict: "useful",
          note: null,
        },
        CTX,
      ),
    ).rejects.toSatisfy(notFound);
    expect(seen.conversation).toBeUndefined();
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
  });

  it("refuses a run whose reply is not in the named conversation", async () => {
    setup({ message: null });
    await expect(
      assistantReplyFeedbackRecordHandler(
        {
          conversationId: CONVERSATION,
          runId: RUN,
          verdict: "useful",
          note: null,
        },
        CTX,
      ),
    ).rejects.toSatisfy(notFound);
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
  });

  it("refuses a caller with no person before any read", async () => {
    setup();
    await expect(
      assistantReplyFeedbackRecordHandler(
        {
          conversationId: CONVERSATION,
          runId: RUN,
          verdict: "useful",
          note: null,
        },
        { ...CTX, userId: null, apiKeyId: null },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "forbidden" &&
        e.reason === "no_principal",
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
  });

  it("refuses a person the role gate refuses before any read", async () => {
    setup();
    mocks.roleRefused = true;
    await expect(
      assistantReplyFeedbackRecordHandler(
        {
          conversationId: CONVERSATION,
          runId: RUN,
          verdict: "useful",
          note: null,
        },
        CTX,
      ),
    ).rejects.toSatisfy((e: unknown) => isHandlerError(e));
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
  });
});

// ── through the kernel: the contract refuses before the handler ──────────────

describe("record_reply_feedback through the kernel", () => {
  beforeEach(() => {
    clearHandlersForTests();
    clearKernelIAMRuntime();
    clearBillingAdmissionGate();
    clearSecurityEventEmitter();
    registerHandler(
      assistantReplyFeedbackRecord.name,
      async () => (input, ctx) =>
        assistantReplyFeedbackRecordHandler(
          input as Parameters<typeof assistantReplyFeedbackRecordHandler>[0],
          ctx,
        ),
    );
  });

  afterEach(() => {
    clearHandlersForTests();
  });

  it("records a vote with a note of exactly the cap", async () => {
    setup();
    const note = "x".repeat(REPLY_FEEDBACK_NOTE_MAX_CHARS);
    await expect(
      invoke(
        assistantReplyFeedbackRecord.name,
        { conversationId: CONVERSATION, runId: RUN, verdict: "wrong", note },
        CTX,
      ),
    ).resolves.toMatchObject({ verdict: "wrong", note });
    expect(mocks.recordReplyFeedback).toHaveBeenCalledTimes(1);
  });

  it("refuses an over-long note as invalid input: no read, no row", async () => {
    setup();
    await expect(
      invoke(
        assistantReplyFeedbackRecord.name,
        {
          conversationId: CONVERSATION,
          runId: RUN,
          verdict: "wrong",
          note: "x".repeat(REPLY_FEEDBACK_NOTE_MAX_CHARS + 1),
        },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.recordReplyFeedback).not.toHaveBeenCalled();
  });
});
