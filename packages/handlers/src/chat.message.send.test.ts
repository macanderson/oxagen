import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  convFindFirst: vi.fn(),
  txConvInsertReturning: vi.fn(),
  txUserMsgInsertReturning: vi.fn(),
  txAsstMsgInsertReturning: vi.fn(),
  txUpdateSetWhere: vi.fn(),
  txFn: vi.fn(),
}));

// ── default mock return values ────────────────────────────────────────────────

mocks.convFindFirst.mockResolvedValue(null);

// Default: all inserts/updates succeed
mocks.txConvInsertReturning.mockResolvedValue([{ id: "conv_1" }]);
mocks.txUserMsgInsertReturning.mockResolvedValue([{ id: "umsg_1" }]);
mocks.txAsstMsgInsertReturning.mockResolvedValue([{ id: "amsg_1" }]);
mocks.txUpdateSetWhere.mockResolvedValue(undefined);

// Transaction mock:
//   insert call #1 → conversation (when conversationId is null)
//   insert call #2 → user message
//   insert call #3 → assistant message
//   update call #1 → conversation.activeLeafMessageId
mocks.txFn.mockImplementation(
  async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
    let insertCount = 0;
    const tx = {
      insert: (_table: unknown): unknown => {
        insertCount++;
        if (insertCount === 1) {
          // First insert: conversation row (new-conversation path)
          return {
            values: (_vals: unknown) => ({
              returning: mocks.txConvInsertReturning,
            }),
          } as unknown;
        }
        if (insertCount === 2) {
          // Second insert: user message
          return {
            values: (_vals: unknown) => ({
              returning: mocks.txUserMsgInsertReturning,
            }),
          } as unknown;
        }
        // Third insert: assistant message
        return {
          values: (_vals: unknown) => ({
            returning: mocks.txAsstMsgInsertReturning,
          }),
        } as unknown;
      },
      query: {
        conversations: { findFirst: mocks.convFindFirst },
      },
      update: (_table: unknown) => ({
        set: (_vals: unknown) => ({
          where: mocks.txUpdateSetWhere,
        }),
      }),
    };
    return cb(tx as unknown as Parameters<typeof cb>[0]);
  },
);

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      query: {
        conversations: { findFirst: mocks.convFindFirst },
      },
      transaction: mocks.txFn,
    }),
    withTenantDb: (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
      mocks.txFn(fn) as Promise<unknown>,
  };
});

import { chatMessageSendHandler } from "./chat.message.send";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const BASE_INPUT = {
  conversationId: null as string | null,
  parentMessageId: null as string | null,
  content: "Hello, assistant",
  contentBlocks: [] as unknown[],
  branchReason: null as
    | "edit"
    | "regenerate"
    | "tool_retry"
    | "manual_fork"
    | null,
};

describe("chatMessageSendHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Restore defaults after clearAllMocks() wipes return values.
    mocks.convFindFirst.mockResolvedValue(null);
    mocks.txConvInsertReturning.mockResolvedValue([{ id: "conv_1" }]);
    mocks.txUserMsgInsertReturning.mockResolvedValue([{ id: "umsg_1" }]);
    mocks.txAsstMsgInsertReturning.mockResolvedValue([{ id: "amsg_1" }]);
    mocks.txUpdateSetWhere.mockResolvedValue(undefined);

    // Restore the transaction mock. The mock tracks insertCount locally, so
    // re-registering it here restores the per-test counter correctly.
    mocks.txFn.mockImplementation(
      async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
        let insertCount = 0;
        const tx = {
          insert: (_table: unknown): unknown => {
            insertCount++;
            if (insertCount === 1) {
              return {
                values: (_vals: unknown) => ({
                  returning: mocks.txConvInsertReturning,
                }),
              } as unknown;
            }
            if (insertCount === 2) {
              return {
                values: (_vals: unknown) => ({
                  returning: mocks.txUserMsgInsertReturning,
                }),
              } as unknown;
            }
            return {
              values: (_vals: unknown) => ({
                returning: mocks.txAsstMsgInsertReturning,
              }),
            } as unknown;
          },
          query: {
            conversations: { findFirst: mocks.convFindFirst },
          },
          update: (_table: unknown) => ({
            set: (_vals: unknown) => ({
              where: mocks.txUpdateSetWhere,
            }),
          }),
        };
        return cb(tx as unknown as Parameters<typeof cb>[0]);
      },
    );
  });

  // ── auth guard ───────────────────────────────────────────────────────────

  it("throws when userId is null (unauthenticated request)", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(chatMessageSendHandler(BASE_INPUT, anonCtx)).rejects.toThrow(
      "chat.message.send requires an authenticated user",
    );
  });

  // ── cross-tenant guard ───────────────────────────────────────────────────

  it("throws 'conversation not found in this tenant' when conversationId does not match orgId", async () => {
    // The handler does the tenant check inside the transaction when an existing
    // conversationId is provided. In that path it queries tx.query.conversations.findFirst
    // and throws if null.
    mocks.txFn.mockImplementationOnce(
      async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          insert: vi.fn(),
          query: {
            conversations: {
              findFirst: vi.fn().mockResolvedValue(null), // not found → cross-tenant
            },
          },
          update: vi.fn(),
        };
        return cb(tx as unknown as Parameters<typeof cb>[0]);
      },
    );

    await expect(
      chatMessageSendHandler(
        { ...BASE_INPUT, conversationId: "conv_other_tenant" },
        CTX,
      ),
    ).rejects.toThrow("conversation not found in this tenant");
  });

  // ── new-conversation path ────────────────────────────────────────────────

  it("creates a new conversation when conversationId is null", async () => {
    const result = await chatMessageSendHandler(
      { ...BASE_INPUT, conversationId: null },
      CTX,
    );

    // Transaction was called exactly once
    expect(mocks.txFn).toHaveBeenCalledTimes(1);
    // Conversation insert was called (first insert inside tx)
    expect(mocks.txConvInsertReturning).toHaveBeenCalledTimes(1);
    // Result uses the newly created conversation id
    expect(result.conversationId).toBe("conv_1");
  });

  it("returns all four ids on the new-conversation happy path", async () => {
    const result = await chatMessageSendHandler(
      { ...BASE_INPUT, conversationId: null },
      CTX,
    );

    expect(result.conversationId).toBe("conv_1");
    expect(result.userMessageId).toBe("umsg_1");
    expect(result.assistantMessageId).toBe("amsg_1");
    expect(result.activeLeafMessageId).toBe("amsg_1");
  });

  // ── existing-conversation path ───────────────────────────────────────────

  it("skips the conversation insert when an existing conversationId is provided", async () => {
    // When conversationId is provided, the tx does NOT call insert for conversations
    // but instead calls tx.query.conversations.findFirst. We wire that mock to
    // return the existing row, then the two message inserts proceed.
    mocks.txFn.mockImplementationOnce(
      async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
        let insertCount = 0;
        const tx = {
          insert: (_table: unknown): unknown => {
            insertCount++;
            // In the existing-conv path: insert #1 = user message, #2 = assistant
            if (insertCount === 1) {
              return {
                values: (_vals: unknown) => ({
                  returning: mocks.txUserMsgInsertReturning,
                }),
              } as unknown;
            }
            return {
              values: (_vals: unknown) => ({
                returning: mocks.txAsstMsgInsertReturning,
              }),
            } as unknown;
          },
          query: {
            conversations: {
              findFirst: vi.fn().mockResolvedValue({ id: "conv_existing" }),
            },
          },
          update: (_table: unknown) => ({
            set: (_vals: unknown) => ({
              where: mocks.txUpdateSetWhere,
            }),
          }),
        };
        return cb(tx as unknown as Parameters<typeof cb>[0]);
      },
    );

    const result = await chatMessageSendHandler(
      { ...BASE_INPUT, conversationId: "conv_existing" },
      CTX,
    );

    // Conversation row must NOT have been inserted (txConvInsertReturning untouched)
    expect(mocks.txConvInsertReturning).not.toHaveBeenCalled();
    // The provided conversationId passes through
    expect(result.conversationId).toBe("conv_existing");
    expect(result.userMessageId).toBe("umsg_1");
    expect(result.assistantMessageId).toBe("amsg_1");
    expect(result.activeLeafMessageId).toBe("amsg_1");
  });

  // ── error paths ──────────────────────────────────────────────────────────

  it("throws when the user message insert returns no row", async () => {
    mocks.txUserMsgInsertReturning.mockResolvedValueOnce([]);

    await expect(
      chatMessageSendHandler({ ...BASE_INPUT, conversationId: null }, CTX),
    ).rejects.toThrow("user message insert returned no row");
  });

  it("runs the full multi-step sequence inside a single transaction", async () => {
    await chatMessageSendHandler({ ...BASE_INPUT, conversationId: null }, CTX);
    expect(mocks.txFn).toHaveBeenCalledTimes(1);
  });
});
