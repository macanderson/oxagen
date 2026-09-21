import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import { PRIOR_MEMBER, RequestPrefixMemory } from "./request-prefix";

const SYSTEM = [
  {
    type: "text",
    text: `You are a careful engineer. ${"Read before you write. ".repeat(40)}`,
  },
];
const TOOLS = [{ name: "Read", input_schema: { type: "object" } }];
const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({ role: "assistant", content: text });

function request(messages: unknown[], over: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: SYSTEM,
    tools: TOOLS,
    messages,
    ...over,
  });
}

describe("RequestPrefixMemory", () => {
  it("stores the first call of a session in full", () => {
    const memory = new RequestPrefixMemory();
    const text = request([user("hello")]);
    const fold = memory.fold("s1", text);
    expect(fold.text).toBe(text);
    expect(fold.prior).toBeUndefined();
    expect(fold.storedBytes).toBe(fold.fullBytes);
    expect(fold.fullDigest).toBe(digestBytes(text));
  });

  it("cuts the messages and fixed fields the previous call already holds", () => {
    const memory = new RequestPrefixMemory();
    const first = request([user("hello")]);
    memory.fold("s1", first);
    const second = request([user("hello"), assistant("hi"), user("read it")]);
    const fold = memory.fold("s1", second);
    expect(fold.prior).toEqual({
      unchanged_from: digestBytes(first),
      messages: 1,
      fields: ["system", "tools"],
    });
    const stored = JSON.parse(fold.text) as Record<string, unknown>;
    expect(stored["messages"]).toEqual([assistant("hi"), user("read it")]);
    expect(stored).not.toHaveProperty("system");
    expect(stored).not.toHaveProperty("tools");
    expect(stored["model"]).toBe("claude-sonnet-5");
    expect(stored[PRIOR_MEMBER]).toEqual(fold.prior);
    expect(fold.storedBytes).toBeLessThan(fold.fullBytes);
    // The chain of priors walks back one call at a time.
    const third = request([
      user("hello"),
      assistant("hi"),
      user("read it"),
      assistant("done"),
      user("now write"),
    ]);
    const again = memory.fold("s1", third);
    expect(again.prior?.unchanged_from).toBe(digestBytes(second));
    expect(again.prior?.messages).toBe(3);
  });

  it("stops the fold at the first message that differs (negative)", () => {
    const memory = new RequestPrefixMemory();
    memory.fold("s1", request([user("hello"), assistant("hi"), user("a")]));
    // Compaction rewrote the second message; nothing past it is shared.
    const fold = memory.fold(
      "s1",
      request([user("hello"), assistant("summary of hi"), user("a")]),
    );
    expect(fold.prior?.messages).toBe(1);
    const stored = JSON.parse(fold.text) as { messages: unknown[] };
    expect(stored.messages).toEqual([assistant("summary of hi"), user("a")]);
  });

  it("keeps a fixed field that changed, and folds the ones that did not", () => {
    const memory = new RequestPrefixMemory();
    memory.fold("s1", request([user("hello")]));
    const fold = memory.fold(
      "s1",
      request([user("hello"), user("more")], {
        tools: [...TOOLS, { name: "Write", input_schema: {} }],
      }),
    );
    expect(fold.prior?.fields).toEqual(["system"]);
    const stored = JSON.parse(fold.text) as Record<string, unknown>;
    expect(stored["tools"]).toHaveLength(2);
    expect(stored).not.toHaveProperty("system");
  });

  it("stores a request in full when the fold would not be smaller (negative)", () => {
    const memory = new RequestPrefixMemory();
    const tiny = (messages: unknown[]) =>
      JSON.stringify({ model: "m", messages });
    memory.fold("s1", tiny([user("a")]));
    const fold = memory.fold("s1", tiny([user("a"), user("b")]));
    expect(fold.prior).toBeUndefined();
    expect(fold.text).toBe(tiny([user("a"), user("b")]));
    expect(fold.storedBytes).toBe(fold.fullBytes);
  });

  it("stores a request in full when nothing is shared, or when the shape is unknown (negative)", () => {
    const memory = new RequestPrefixMemory();
    memory.fold("s1", request([user("hello")]));
    const other = JSON.stringify({
      model: "x",
      system: "different",
      messages: [user("new")],
    });
    const fold = memory.fold("s1", other);
    expect(fold.text).toBe(other);
    expect(fold.prior).toBeUndefined();
    // Not an object at all: stored as it came, and the session's memory is
    // dropped so the next call does not fold against a stale prior.
    const raw = memory.fold("s1", "not json");
    expect(raw.text).toBe("not json");
    const after = memory.fold("s1", request([user("hello")]));
    expect(after.prior).toBeUndefined();
  });

  it("keeps sessions apart, and forgets one on request", () => {
    const memory = new RequestPrefixMemory();
    memory.fold("s1", request([user("hello")]));
    const other = memory.fold("s2", request([user("hello"), user("x")]));
    expect(other.prior).toBeUndefined();
    memory.forget("s1");
    const again = memory.fold("s1", request([user("hello"), user("y")]));
    expect(again.prior).toBeUndefined();
  });

  it("folds the Responses API's input array the same way", () => {
    const memory = new RequestPrefixMemory();
    const instructions = `Be brief. ${"Cite the file you read. ".repeat(40)}`;
    const first = JSON.stringify({
      model: "gpt-5",
      instructions,
      input: [{ role: "user", content: "hello" }],
    });
    memory.fold("s1", first);
    const fold = memory.fold(
      "s1",
      JSON.stringify({
        model: "gpt-5",
        instructions,
        input: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
    );
    expect(fold.prior).toEqual({
      unchanged_from: digestBytes(first),
      messages: 1,
      fields: ["instructions"],
    });
  });
});
