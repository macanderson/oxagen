// conversation.handlers.test.ts — handler invocation tests for conversation tools.
//
// Pattern: vi.mock the kernel `invoke` and context seam `buildContext`.
// Schema assertions (valid/invalid parse) live in conversations.schema.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

// ── conversation.archive ──────────────────────────────────────────────────────

import handler_conversationArchive, {
  schema as conversationArchiveSchema,
  metadata as conversationArchiveMetadata,
} from "./conversation.archive";

describe("conversation.archive handler", () => {
  it("exports schema and metadata", () => {
    expect(conversationArchiveSchema).toBeDefined();
    expect(conversationArchiveMetadata.name).toBe("archive_conversation");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = { updated: 2 };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { conversationIds: ["cnv_1", "cnv_2"], archived: true };
    const result = await handler_conversationArchive(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "archive_conversation",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ updated: 2 });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("not found"));
    await expect(
      handler_conversationArchive({
        conversationIds: ["cnv_x"],
        archived: false,
      }),
    ).rejects.toThrow("not found");
  });
});

// ── conversation.delete ───────────────────────────────────────────────────────

import handler_conversationDelete, {
  schema as conversationDeleteSchema,
  metadata as conversationDeleteMetadata,
} from "./conversation.delete";

describe("conversation.delete handler", () => {
  it("exports schema and metadata", () => {
    expect(conversationDeleteSchema).toBeDefined();
    expect(conversationDeleteMetadata.name).toBe("delete_conversation");
  });

  it("calls invoke with delete args", async () => {
    const fakeOutput = { deleted: 1 };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { conversationIds: ["cnv_1"] };
    await handler_conversationDelete(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "delete_conversation",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── conversation.list ─────────────────────────────────────────────────────────

import handler_conversationList, {
  schema as conversationListSchema,
  metadata as conversationListMetadata,
} from "./conversation.list";

describe("conversation.list handler", () => {
  it("exports schema and metadata", () => {
    expect(conversationListSchema).toBeDefined();
    expect(conversationListMetadata.name).toBe("list_conversations");
  });

  it("calls invoke with list args", async () => {
    const fakeOutput = { conversations: [], nextCursor: null, total: 0 };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { filter: "active" as const, limit: 20, cursor: null };
    await handler_conversationList(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_conversations",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── conversation.purge ────────────────────────────────────────────────────────

import handler_conversationPurge, {
  schema as conversationPurgeSchema,
  metadata as conversationPurgeMetadata,
} from "./conversation.purge";

describe("conversation.purge handler", () => {
  it("exports schema and metadata", () => {
    expect(conversationPurgeSchema).toBeDefined();
    expect(conversationPurgeMetadata.name).toBe("purge_conversations");
  });

  it("calls invoke with empty args for purge", async () => {
    const fakeOutput = { deleted: 42 };
    mocks.invoke.mockResolvedValue(fakeOutput);

    await handler_conversationPurge({});

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "purge_conversations",
      {},
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── conversation.rename ───────────────────────────────────────────────────────

import handler_conversationRename, {
  schema as conversationRenameSchema,
  metadata as conversationRenameMetadata,
} from "./conversation.rename";

describe("conversation.rename handler", () => {
  it("exports schema and metadata", () => {
    expect(conversationRenameSchema).toBeDefined();
    expect(conversationRenameMetadata.name).toBe("rename_conversation");
  });

  it("calls invoke with rename args", async () => {
    const fakeOutput = { publicId: "cnv_1", title: "New Title" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { conversationId: "cnv_1", title: "New Title" };
    const result = await handler_conversationRename(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "rename_conversation",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ title: "New Title" });
  });
});

// ── chat.message.send ─────────────────────────────────────────────────────────

import handler_chatMessageSend, {
  schema as chatMessageSendSchema,
  metadata as chatMessageSendMetadata,
} from "./chat.message.send";

describe("chat.message.send handler", () => {
  it("exports schema and metadata", () => {
    expect(chatMessageSendSchema).toBeDefined();
    expect(chatMessageSendMetadata.name).toBe("send_message");
  });

  it("calls invoke with send args", async () => {
    const fakeOutput = {
      conversationId: "cnv_new",
      userMessageId: "msg_1",
      assistantMessageId: "msg_2",
      activeLeafMessageId: "msg_2",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      conversationId: null,
      parentMessageId: null,
      branchReason: null,
      content: "Hello!",
      contentBlocks: [],
    };
    await handler_chatMessageSend(args);

    expect(mocks.invoke).toHaveBeenCalledWith("send_message", args, fakeCtx, {
      surface: "mcp",
    });
  });
});
