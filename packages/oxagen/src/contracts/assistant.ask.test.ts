import { describe, expect, it } from "vitest";
import {
  assistantAsk,
  assistantParkedCardSchema,
  assistantToolCallSchema,
} from "./assistant.ask";
import { CHAT_CONTENT_MAX_CHARS } from "./chat.message.send";

const CONVERSATION = "0192d4a8-7c1e-7a00-8000-0000000000c1";

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
      assistantAsk.input.safeParse({ content: "hi", attachments: [] }).success,
    ).toBe(false);
  });

  it("answers with the run the turn was recorded as and every parked card", () => {
    const output = {
      conversationId: CONVERSATION,
      userMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
      assistantMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d2",
      runId: "arun_0123456789abcdef012345",
      reply: "Three runs are live.",
      parkedCards: [],
      toolCalls: [],
    };
    expect(assistantAsk.output.parse(output)).toEqual(output);
    expect(
      assistantAsk.output.safeParse({ ...output, runId: "tse_abc" }).success,
    ).toBe(false);
    expect(
      assistantParkedCardSchema.parse({
        approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
        capability: "set_budget",
        expiresAt: "2026-09-14T10:05:00.000Z",
      }).capability,
    ).toBe("set_budget");
  });

  it("answers with every tool call behind the reply, a parked one naming its approval", () => {
    const output = {
      conversationId: CONVERSATION,
      userMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
      assistantMessageId: "0192d4a8-7c1e-7a00-8000-0000000000d2",
      runId: "arun_0123456789abcdef012345",
      reply: "The budget change is waiting on you.",
      parkedCards: [
        {
          approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
          capability: "set_budget",
          expiresAt: "2026-09-14T10:05:00.000Z",
        },
      ],
      toolCalls: [
        {
          toolCallId: "tc-1",
          toolName: "list_runs",
          outcome: "completed",
          durationMs: 41,
          approvalId: null,
        },
        {
          toolCallId: "tc-2",
          toolName: "set_budget",
          outcome: "parked",
          durationMs: 7,
          approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
        },
      ],
    };
    expect(assistantAsk.output.parse(output)).toEqual(output);
  });

  it("refuses a tool call with an unknown outcome, a fractional duration or an extra key (negative)", () => {
    const call = {
      toolCallId: "tc-1",
      toolName: "list_runs",
      outcome: "completed",
      durationMs: 41,
      approvalId: null,
    };
    expect(assistantToolCallSchema.safeParse(call).success).toBe(true);
    expect(
      assistantToolCallSchema.safeParse({ ...call, outcome: "pending" })
        .success,
    ).toBe(false);
    expect(
      assistantToolCallSchema.safeParse({ ...call, durationMs: 4.5 }).success,
    ).toBe(false);
    expect(
      assistantToolCallSchema.safeParse({ ...call, input: {} }).success,
    ).toBe(false);
  });
});
