import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { CONVERSATION_MESSAGES_MAX, conversationGet } from "./conversation.get";

const MESSAGE = {
  publicId: "msg_01k9x2",
  role: "assistant" as const,
  content: "Three runs are live.",
  createdAt: "2026-09-25T10:00:00.000Z",
  runId: "arun_0123456789abcdef012345",
  parkedCards: [
    {
      approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
      capability: "set_budget",
      expiresAt: "2026-09-25T10:05:00.000Z",
    },
  ],
  toolCalls: [
    {
      toolCallId: "tc-1",
      toolName: "list_runs",
      outcome: "completed" as const,
      durationMs: 12,
      approvalId: null,
    },
    {
      toolCallId: "tc-2",
      toolName: "set_budget",
      outcome: "parked" as const,
      durationMs: 3,
      approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
    },
  ],
};

const CONVERSATION = {
  publicId: "cnv_01k9x2",
  title: null,
  status: "active",
  archivedAt: null,
  createdAt: "2026-09-25T09:59:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  messages: [MESSAGE],
  truncated: false,
};

describe("get_conversation contract", () => {
  it("is registered as a scoped read that no credit balance can refuse", () => {
    expect(getCapability("get_conversation")).toBe(conversationGet);
    expect(conversationGet.mutates).toBe(false);
    expect(conversationGet.scoped).toBe(true);
    expect(conversationGet.noBillingGate).toBe(true);
    expect(conversationGet.defaultEffect).toBe("deny");
    expect(conversationGet.surfaces).toEqual(["api", "mcp"]);
    expect(conversationGet.layers).toContain("app");
  });

  it("reads the latest active conversation when no id is given", () => {
    expect(conversationGet.input.parse({})).toEqual({
      conversationId: null,
      limit: 100,
    });
  });

  it("takes a cnv_ public id in either case", () => {
    expect(
      conversationGet.input.parse({ conversationId: "cnv_01k9x2" })
        .conversationId,
    ).toBe("cnv_01k9x2");
    expect(
      conversationGet.input.parse({ conversationId: "CNV_01K9X2" })
        .conversationId,
    ).toBe("CNV_01K9X2");
  });

  it("refuses an internal uuid, another prefix, and a limit out of range (negative)", () => {
    const refused = [
      { conversationId: "0192d4a8-7c1e-7a00-8000-0000000000c1" },
      { conversationId: "msg_01k9x2" },
      { conversationId: "cnv_" },
      { limit: 0 },
      { limit: CONVERSATION_MESSAGES_MAX + 1 },
      { limit: 1.5 },
    ];
    for (const input of refused) {
      expect(conversationGet.input.safeParse(input).success).toBe(false);
    }
  });

  it("answers a conversation with its messages, or null", () => {
    const found = { conversation: CONVERSATION };
    expect(conversationGet.output.parse(found)).toEqual(found);
    expect(conversationGet.output.parse({ conversation: null })).toEqual({
      conversation: null,
    });
  });

  it("refuses a message role the thread never carries and a malformed parked card (negative)", () => {
    const tool = { ...MESSAGE, role: "tool" };
    expect(
      conversationGet.output.safeParse({
        conversation: { ...CONVERSATION, messages: [tool] },
      }).success,
    ).toBe(false);
    const parked = { ...MESSAGE, parkedCards: [{ approvalId: "apr_1" }] };
    expect(
      conversationGet.output.safeParse({
        conversation: { ...CONVERSATION, messages: [parked] },
      }).success,
    ).toBe(false);
  });

  it("requires each message's tool calls and holds each call to the ask_assistant shape (negative)", () => {
    const withoutCalls: Record<string, unknown> = { ...MESSAGE };
    delete withoutCalls.toolCalls;
    const [call] = MESSAGE.toolCalls;
    const refused = [
      withoutCalls,
      { ...MESSAGE, toolCalls: [{ ...call, outcome: "skipped" }] },
      { ...MESSAGE, toolCalls: [{ ...call, durationMs: -1 }] },
      { ...MESSAGE, toolCalls: [{ ...call, alias: "list_runs_2" }] },
    ];
    for (const message of refused) {
      expect(
        conversationGet.output.safeParse({
          conversation: { ...CONVERSATION, messages: [message] },
        }).success,
      ).toBe(false);
    }
  });
});
