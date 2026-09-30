import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import {
  type PrefixFold,
  PRIOR_MEMBER,
  RequestPrefixMemory,
} from "./request-prefix";

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

/**
 * Fold a call and remember it, as the proxy does for a call whose frame
 * reached the WAL before the next call was sent.
 */
function landed<T>(
  memory: RequestPrefixMemory<T>,
  sessionKey: string,
  text: string,
  payload?: T,
): PrefixFold<T> {
  const fold = memory.fold(sessionKey, text);
  memory.remember(sessionKey, fold, payload);
  return fold;
}

describe("RequestPrefixMemory", () => {
  it("stores the first call of a session in full", () => {
    const memory = new RequestPrefixMemory();
    const text = request([user("hello")]);
    const fold = landed(memory, "s1", text);
    expect(fold.text).toBe(text);
    expect(fold.prior).toBeUndefined();
    expect(fold.storedBytes).toBe(fold.fullBytes);
    expect(fold.fullDigest).toBe(digestBytes(text));
  });

  it("cuts the messages and fixed fields the previous call already holds", () => {
    const memory = new RequestPrefixMemory();
    const first = request([user("hello")]);
    landed(memory, "s1", first);
    const second = request([user("hello"), assistant("hi"), user("read it")]);
    const fold = landed(memory, "s1", second);
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
    const again = landed(memory, "s1", third);
    expect(again.prior?.unchanged_from).toBe(digestBytes(second));
    expect(again.prior?.messages).toBe(3);
  });

  it("stops the fold at the first message that differs (negative)", () => {
    const memory = new RequestPrefixMemory();
    landed(
      memory,
      "s1",
      request([user("hello"), assistant("hi"), user("a")]),
    );
    // Compaction rewrote the second message; nothing past it is shared.
    const fold = landed(
      memory,
      "s1",
      request([user("hello"), assistant("summary of hi"), user("a")]),
    );
    expect(fold.prior?.messages).toBe(1);
    const stored = JSON.parse(fold.text) as { messages: unknown[] };
    expect(stored.messages).toEqual([assistant("summary of hi"), user("a")]);
  });

  it("keeps a fixed field that changed, and folds the ones that did not", () => {
    const memory = new RequestPrefixMemory();
    landed(memory, "s1", request([user("hello")]));
    const fold = landed(
      memory,
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
    landed(memory, "s1", tiny([user("a")]));
    const fold = landed(memory, "s1", tiny([user("a"), user("b")]));
    expect(fold.prior).toBeUndefined();
    expect(fold.text).toBe(tiny([user("a"), user("b")]));
    expect(fold.storedBytes).toBe(fold.fullBytes);
  });

  it("stores a request in full when nothing is shared, or when the shape is unknown (negative)", () => {
    const memory = new RequestPrefixMemory();
    landed(memory, "s1", request([user("hello")]));
    const other = JSON.stringify({
      model: "x",
      system: "different",
      messages: [user("new")],
    });
    const fold = landed(memory, "s1", other);
    expect(fold.text).toBe(other);
    expect(fold.prior).toBeUndefined();
    // Not an object at all: stored as it came, and the session's memory is
    // dropped so the next call does not fold against a stale prior.
    const raw = landed(memory, "s1", "not json");
    expect(raw.text).toBe("not json");
    expect(raw.shape).toBeUndefined();
    const after = memory.fold("s1", request([user("hello")]));
    expect(after.prior).toBeUndefined();
  });

  it("keeps sessions apart, and forgets one on request", () => {
    const memory = new RequestPrefixMemory();
    landed(memory, "s1", request([user("hello")]));
    const other = landed(memory, "s2", request([user("hello"), user("x")]));
    expect(other.prior).toBeUndefined();
    memory.forget("s1");
    const again = landed(memory, "s1", request([user("hello"), user("y")]));
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
    landed(memory, "s1", first);
    const fold = landed(
      memory,
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

describe("RequestPrefixMemory folding before a call lands (#4348)", () => {
  it("changes nothing on a fold: a call is a prior only once it is remembered", () => {
    const memory = new RequestPrefixMemory();
    const first = request([user("hello")]);
    const a = memory.fold("s1", first);
    // A's body has not landed, so B has nothing to fold against.
    const b = memory.fold("s1", request([user("hello"), user("more")]));
    expect(b.prior).toBeUndefined();
    memory.remember("s1", a);
    const c = memory.fold("s1", request([user("hello"), user("again")]));
    expect(c.prior?.unchanged_from).toBe(digestBytes(first));
  });

  it("folds two overlapping calls against the last call that landed, never against each other", () => {
    const memory = new RequestPrefixMemory();
    const landedFirst = request([user("hello")]);
    landed(memory, "s1", landedFirst);
    const aText = request([user("hello"), assistant("hi"), user("a")]);
    const bText = request([
      user("hello"),
      assistant("hi"),
      user("a"),
      assistant("ok"),
      user("b"),
    ]);
    const a = memory.fold("s1", aText);
    const b = memory.fold("s1", bText);
    expect(a.prior?.unchanged_from).toBe(digestBytes(landedFirst));
    expect(b.prior?.unchanged_from).toBe(digestBytes(landedFirst));
    // B lands first. A's frame never does, so A is never remembered, and
    // the next call folds against B.
    memory.remember("s1", b);
    const next = memory.fold("s1", request([user("hello"), user("c")]));
    expect(next.prior?.unchanged_from).toBe(digestBytes(bText));
    expect(next.prior?.unchanged_from).not.toBe(digestBytes(aText));
  });

  it("hands a fold the payload remembered with the call it cut against", () => {
    const memory = new RequestPrefixMemory<string>();
    landed(memory, "s1", request([user("hello")]), "context of the first");
    const fold = memory.fold("s1", request([user("hello"), user("more")]));
    expect(fold.prior).toBeDefined();
    expect(fold.priorPayload).toBe("context of the first");
    // A fold that cut nothing carries no payload (negative).
    const whole = memory.fold(
      "s1",
      JSON.stringify({ model: "x", system: "other", messages: [] }),
    );
    expect(whole.prior).toBeUndefined();
    expect(whole.priorPayload).toBeUndefined();
    // Each session keeps its own.
    expect(memory.fold("s2", request([user("hello")])).priorPayload).toBe(
      undefined,
    );
  });
});
