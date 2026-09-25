// conversation.get.test.ts: schema and handler invocation tests for the
// get_conversation MCP tool (same pattern as conversation.export.test.ts:
// mock the kernel `invoke` and the context seam `buildContext`).

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import conversationGetTool, { metadata, schema } from "./conversation.get";

const CONVERSATION = {
  publicId: "cnv_01k9x2",
  title: null,
  status: "active",
  archivedAt: null,
  createdAt: "2026-09-25T09:59:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  messages: [
    {
      publicId: "msg_a1",
      role: "user",
      content: "what is live?",
      createdAt: "2026-09-25T10:00:00.000Z",
      runId: null,
      parkedCards: [],
    },
  ],
  truncated: false,
};

describe("get_conversation tool", () => {
  it("is a read-only, idempotent tool named for the capability", () => {
    expect(metadata.name).toBe("get_conversation");
    expect(metadata.annotations?.readOnlyHint).toBe(true);
    expect(metadata.annotations?.idempotentHint).toBe(true);
    expect(schema.conversationId.parse(undefined)).toBeNull();
    expect(schema.limit.parse(undefined)).toBe(100);
  });

  it("invokes get_conversation on the mcp surface and returns the thread", async () => {
    mocks.invoke.mockResolvedValue({ conversation: CONVERSATION });
    const args = { conversationId: "cnv_01k9x2", limit: 50 };
    const out = await conversationGetTool(args);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_conversation",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(out).toEqual({ conversation: CONVERSATION });
  });

  it("propagates a not_found refusal (negative)", async () => {
    mocks.invoke.mockRejectedValue(new Error("not_found"));
    await expect(
      conversationGetTool({ conversationId: "cnv_01k9zz", limit: 100 }),
    ).rejects.toThrow("not_found");
  });
});
