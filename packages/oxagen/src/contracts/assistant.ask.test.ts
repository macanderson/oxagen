import { describe, expect, it } from "vitest";
import { assistantAsk, assistantParkedCardSchema } from "./assistant.ask";
import { CHAT_CONTENT_MAX_CHARS } from "./chat.message.send";

const CONVERSATION = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const CONVERSATION_PUBLIC_ID = "cnv_01k9x2tq";

describe("ask_assistant contract", () => {
  it("is an async, mutating, scoped turn that is not a governed action itself (#2968 decision 3)", () => {
    expect(assistantAsk.mode).toBe("async");
    expect(assistantAsk.mutates).toBe(true);
    expect(assistantAsk.scoped).toBe(true);
    expect(assistantAsk.noBillingGate).toBe(true);
    expect(assistantAsk.defaultEffect).toBe("deny");
    expect(assistantAsk.layers).not.toContain("e2e");
  });

  it("opens a new conversation on a null id and accepts a page context", () => {
    expect(assistantAsk.input.parse({ content: "hi" })).toEqual({
      conversationId: null,
      content: "hi",
      pageContext: null,
    });
    expect(
      assistantAsk.input.parse({
        conversationId: CONVERSATION,
        content: "explain this run",
        pageContext: { route: "run", orgSlug: "acme", workspaceSlug: "core" },
      }).pageContext,
    ).toEqual({
      route: "run",
      orgSlug: "acme",
      workspaceSlug: "core",
      entityId: null,
    });
  });

  // #4163: the conversation capabilities key on the cnv_ public id, and the
  // app reads a thread back through get_conversation, which carries only that.
  it("continues a conversation by its cnv_ public id as well as its internal id", () => {
    expect(
      assistantAsk.input.parse({
        conversationId: CONVERSATION_PUBLIC_ID,
        content: "and now?",
      }).conversationId,
    ).toBe(CONVERSATION_PUBLIC_ID);
    expect(
      assistantAsk.input.parse({ conversationId: CONVERSATION, content: "hi" })
        .conversationId,
    ).toBe(CONVERSATION);
  });

  it("refuses an empty message, one past the shared cap, a non-uuid conversation and an unknown key (negative)", () => {
    expect(assistantAsk.input.safeParse({ content: "" }).success).toBe(false);
    expect(
      assistantAsk.input.safeParse({
        content: "x".repeat(CHAT_CONTENT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      assistantAsk.input.safeParse({ content: "hi", conversationId: "conv_1" })
        .success,
    ).toBe(false);
    expect(
      assistantAsk.input.safeParse({ content: "hi", conversationId: "msg_1" })
        .success,
    ).toBe(false);
    expect(
      assistantAsk.input.safeParse({ content: "hi", attachments: [] }).success,
    ).toBe(false);
  });

  it("answers with the run the turn was recorded as and every parked card", () => {
    const output = {
      conversationId: CONVERSATION,
      conversationPublicId: CONVERSATION_PUBLIC_ID,
      userMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
      assistantMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d2",
      runId: "arun_0123456789abcdef012345",
      reply: "Three runs are live.",
      parkedCards: [],
    };
    expect(assistantAsk.output.parse(output)).toEqual(output);
    expect(
      assistantAsk.output.safeParse({ ...output, runId: "tse_abc" }).success,
    ).toBe(false);
    const withoutPublicId: Record<string, unknown> = { ...output };
    delete withoutPublicId.conversationPublicId;
    expect(assistantAsk.output.safeParse(withoutPublicId).success).toBe(false);
    expect(
      assistantParkedCardSchema.parse({
        approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
        capability: "set_budget",
        expiresAt: "2026-09-14T10:05:00.000Z",
      }).capability,
    ).toBe("set_budget");
  });
});
