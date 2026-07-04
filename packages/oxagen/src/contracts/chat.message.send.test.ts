import { describe, expect, it } from "vitest";
import { chatMessageSend } from "./chat.message.send";

describe("chat.message.send capability", () => {
  it("parses a valid input starting a new conversation", () => {
    const parsed = chatMessageSend.input.parse({
      conversationId: null,
      parentMessageId: null,
      branchReason: null,
      content: "Hello",
    });
    expect(parsed.contentBlocks).toEqual([]);
  });

  it("parses a regenerate branch", () => {
    const parsed = chatMessageSend.input.parse({
      conversationId: "c1",
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
        parentMessageId: null,
        branchReason: null,
        content: "",
      }),
    ).toThrow();
  });

  it("defaults attachments to an empty array when omitted", () => {
    const parsed = chatMessageSend.input.parse({
      conversationId: null,
      parentMessageId: null,
      branchReason: null,
      content: "Hello",
    });
    expect(parsed.attachments).toEqual([]);
  });

  it("parses valid attachments", () => {
    const parsed = chatMessageSend.input.parse({
      conversationId: null,
      parentMessageId: null,
      branchReason: null,
      content: "look at this",
      attachments: [
        {
          publicId: "gen_abc",
          kind: "image",
          name: "cat.png",
          mimeType: "image/png",
          url: "/api/v1/assets/gen_abc",
          sizeBytes: 2048,
        },
      ],
    });
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.publicId).toBe("gen_abc");
  });

  it("rejects an attachment with an invalid kind", () => {
    expect(() =>
      chatMessageSend.input.parse({
        conversationId: null,
        parentMessageId: null,
        branchReason: null,
        content: "x",
        attachments: [
          { publicId: "gen_abc", kind: "avatar", name: "a", mimeType: "image/png", url: "/x" },
        ],
      }),
    ).toThrow();
  });

  it("rejects more than 8 attachments", () => {
    const attachments = Array.from({ length: 9 }, (_, i) => ({
      publicId: `gen_${i}`,
      kind: "image" as const,
      name: `f${i}.png`,
      mimeType: "image/png",
      url: `/api/v1/assets/gen_${i}`,
    }));
    expect(() =>
      chatMessageSend.input.parse({
        conversationId: null,
        parentMessageId: null,
        branchReason: null,
        content: "x",
        attachments,
      }),
    ).toThrow();
  });

  it("rejects an invalid branch reason", () => {
    expect(() =>
      chatMessageSend.input.parse({
        conversationId: "c1",
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
