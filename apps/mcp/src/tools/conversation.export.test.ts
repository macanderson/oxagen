// conversation.export.test.ts — schema + handler invocation tests for the
// conversation.export MCP tool (same pattern as conversation.handlers.test.ts:
// mock the kernel `invoke` and the context seam `buildContext`).

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
  userId: "u_test",
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

import conversationExportTool, {
  schema as conversationExportSchema,
  metadata as conversationExportMetadata,
} from "./conversation.export";

describe("conversation.export tool", () => {
  it("exports schema and metadata", () => {
    expect(conversationExportSchema.conversationId).toBeDefined();
    expect(conversationExportSchema.format).toBeDefined();
    expect(conversationExportMetadata.name).toBe("export_conversation");
    // PDF export persists an asset — must not advertise read-only.
    expect(conversationExportMetadata.annotations?.readOnlyHint).toBe(false);
    expect(conversationExportMetadata.annotations?.destructiveHint).toBe(false);
  });

  it("calls buildContext then invoke with correct args (markdown)", async () => {
    const fakeOutput = {
      format: "markdown",
      filename: "chat-2026-07-07.md",
      content: "# Chat",
      url: null,
      messageCount: 3,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { conversationId: "cnv_1", format: "markdown" as const };
    const result = await conversationExportTool(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "export_conversation",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(fakeOutput);
  });

  it("parses and returns the pdf output shape", async () => {
    const fakeOutput = {
      format: "pdf",
      filename: "chat-2026-07-07.pdf",
      content: null,
      url: "/api/v1/assets/gen_1",
      messageCount: 3,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const result = await conversationExportTool({
      conversationId: "cnv_1",
      format: "pdf",
    });
    expect(result).toEqual(fakeOutput);
  });

  it("rejects when the kernel returns a malformed output", async () => {
    mocks.invoke.mockResolvedValue({ format: "pdf" });
    await expect(
      conversationExportTool({ conversationId: "cnv_1", format: "pdf" }),
    ).rejects.toThrow();
  });
});
