import { describe, expect, it } from "vitest";
import { chatMessageSend } from "./chat.message.send";

describe("chat.message.send capability", () => {
  it("parses a valid input starting a new conversation", () => {
    const parsed = chatMessageSend.input.parse({
      conversationId: null,
      agentVersionId: null,
      parentMessageId: null,
      branchReason: null,
      content: "Hello",
    });
    expect(parsed.contentBlocks).toEqual([]);
  });

  it("parses a regenerate branch", () => {
    const parsed = chatMessageSend.input.parse({
      conversationId: "c1",
      agentVersionId: "av1",
      parentMessageId: "m1",
      branchReason: "regenerate",
      content: "Try again",
      contentBlocks: [{ type: "text", text: "Try again" }],
    });
    expect(parsed.branchReason).toBe("regenerate");
  });

  it("rejects an empty content body", () => {
    expect(() =>
      chatMessageSend.input.parse({
        conversationId: null,
        agentVersionId: null,
        parentMessageId: null,
        branchReason: null,
        content: "",
      }),
    ).toThrow();
  });

  it("rejects an invalid branch reason", () => {
    expect(() =>
      chatMessageSend.input.parse({
        conversationId: "c1",
        agentVersionId: null,
        parentMessageId: "m1",
        branchReason: "rewind",
        content: "x",
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = chatMessageSend.output.parse({
      conversationId: "c1",
      userMessageId: "m1",
      assistantMessageId: "m2",
      activeLeafMessageId: "m2",
    });
    expect(parsed.activeLeafMessageId).toBe("m2");
  });
});
