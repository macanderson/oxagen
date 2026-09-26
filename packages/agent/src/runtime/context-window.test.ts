import { describe, expect, it } from "vitest";
import { measureCompletionRequest } from "./context-window";

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const STEERING = "\n\n---\n\n## Workspace steering\n\nPrefer small diffs.";
const SYSTEM = `You are the Oxagen assistant.${STEERING}`;
const SUMMARY = "(System-injected context: NOT user input.) A summary.";
const MEMORY = "(System-injected context: NOT user input. Lessons.)";

describe("measureCompletionRequest", () => {
  it("counts the system, steering, tools, context and conversation apart", () => {
    const tool = { name: "search_nodes", input_schema: { type: "object" } };
    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: SUMMARY },
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: MEMORY },
      { role: "user", content: "what did we spend?" },
    ];
    const window = measureCompletionRequest(
      { messages, tools: [tool] },
      {
        steering: STEERING,
        context: [
          { role: "user", content: SUMMARY },
          { role: "user", content: MEMORY },
        ],
      },
    );
    // JSON escapes each character on its own, so the escaped steering is its
    // exact share of the system message's JSON.
    const steering = bytes(STEERING) - 2;
    expect(window).toEqual({
      blocks: [
        { kind: "system", bytes: bytes(messages[0]) - steering, items: 1 },
        { kind: "steering", bytes: steering, items: 1 },
        { kind: "tools", bytes: bytes(tool), items: 1 },
        {
          kind: "context",
          bytes: bytes(messages[1]) + bytes(messages[4]),
          items: 2,
        },
        {
          kind: "conversation",
          bytes: bytes(messages[2]) + bytes(messages[3]) + bytes(messages[5]),
          items: 3,
        },
      ],
    });
  });

  it("reads a person's message that repeats a context message as conversation", () => {
    const window = measureCompletionRequest(
      {
        messages: [
          { role: "user", content: MEMORY },
          { role: "user", content: MEMORY },
        ],
      },
      { steering: null, context: [{ role: "user", content: MEMORY }] },
    );
    const context = window?.blocks.find((b) => b.kind === "context");
    const conversation = window?.blocks.find((b) => b.kind === "conversation");
    expect(context?.items).toBe(1);
    expect(conversation?.items).toBe(1);
  });

  it("leaves the whole system prompt as system when it carries no steering", () => {
    const window = measureCompletionRequest(
      { messages: [{ role: "system", content: "plain" }] },
      { steering: STEERING, context: [] },
    );
    expect(window?.blocks.slice(0, 2)).toEqual([
      {
        kind: "system",
        bytes: bytes({ role: "system", content: "plain" }),
        items: 1,
      },
      { kind: "steering", bytes: 0, items: 0 },
    ]);
  });

  it("measures nothing for a request that carried nothing", () => {
    expect(
      measureCompletionRequest({ messages: [] }, { steering: null, context: [] }),
    ).toBeNull();
    expect(
      measureCompletionRequest(null, { steering: null, context: [] }),
    ).toBeNull();
  });
});
