import { describe, expect, it } from "vitest";
import {
  apportionWindowTokens,
  type ContextWindowBlock,
  decodeWindowAttr,
  encodeWindowAttr,
  measureProviderRequest,
  windowBlockOf,
  windowJsonBytes,
} from "./context-window";

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

describe("measureProviderRequest", () => {
  it("splits an Anthropic request into its system, tools and messages", () => {
    const tools = [
      { name: "Read", input_schema: { type: "object" } },
      { name: "Edit", input_schema: { type: "object" } },
    ];
    const messages = [
      { role: "user", content: "fix the flaky test" },
      { role: "assistant", content: "Reading it now." },
    ];
    const window = measureProviderRequest("anthropic.messages", {
      model: "claude-sonnet-5",
      system: "you are helpful",
      tools,
      messages,
    });
    expect(window).toEqual([
      { kind: "system", bytes: bytes("you are helpful"), items: 1 },
      { kind: "tools", bytes: bytes(tools[0]) + bytes(tools[1]), items: 2 },
      {
        kind: "conversation",
        bytes: bytes(messages[0]) + bytes(messages[1]),
        items: 2,
      },
    ]);
  });

  it("reads an OpenAI Chat request's leading system and developer messages as its system", () => {
    const messages = [
      { role: "system", content: "rules" },
      { role: "developer", content: "more rules" },
      { role: "user", content: "hi" },
      { role: "system", content: "a later system message is conversation" },
    ];
    const window = measureProviderRequest("openai.chat", { messages });
    expect(window).toEqual([
      {
        kind: "system",
        bytes: bytes(messages[0]) + bytes(messages[1]),
        items: 2,
      },
      { kind: "tools", bytes: 0, items: 0 },
      {
        kind: "conversation",
        bytes: bytes(messages[2]) + bytes(messages[3]),
        items: 2,
      },
    ]);
  });

  it("reads an OpenAI Responses request's instructions and input", () => {
    const window = measureProviderRequest("openai.responses", {
      instructions: "base",
      input: "one prompt",
    });
    expect(window).toEqual([
      { kind: "system", bytes: bytes("base"), items: 1 },
      { kind: "tools", bytes: 0, items: 0 },
      { kind: "conversation", bytes: bytes("one prompt"), items: 1 },
    ]);
  });

  it("counts what an injection added to the system block as steering", () => {
    const original = { system: "you are helpful", messages: [] };
    const sent = {
      system: [
        { type: "text", text: "you are helpful" },
        { type: "text", text: "STEER: prefer small diffs" },
      ],
      messages: [],
    };
    const window = measureProviderRequest(
      "anthropic.messages",
      sent,
      original,
    );
    const system = bytes("you are helpful");
    const whole = bytes(sent.system[0]) + bytes(sent.system[1]);
    expect(window).toEqual([
      { kind: "system", bytes: system, items: 1 },
      { kind: "steering", bytes: whole - system, items: 1 },
      { kind: "tools", bytes: 0, items: 0 },
      { kind: "conversation", bytes: 0, items: 0 },
    ]);
  });

  it("measures nothing for an API it does not parse, a missing body, or an empty one", () => {
    expect(measureProviderRequest("other", { messages: [] })).toBeNull();
    expect(measureProviderRequest("anthropic.messages", undefined)).toBeNull();
    expect(measureProviderRequest("anthropic.messages", {})).toBeNull();
  });
});

describe("the window attribute", () => {
  const blocks: ContextWindowBlock[] = [
    { kind: "conversation", bytes: 48_211, items: 37 },
    { kind: "system", bytes: 1204, items: 1 },
    { kind: "tools", bytes: 9120, items: 14 },
  ];

  it("writes the blocks in window order and reads them back", () => {
    const value = encodeWindowAttr(blocks);
    expect(value).toBe("system=1204:1;tools=9120:14;conversation=48211:37");
    expect(decodeWindowAttr(value)).toEqual([blocks[1], blocks[2], blocks[0]]);
  });

  it("reads nothing from a value with any part it cannot read", () => {
    expect(decodeWindowAttr(undefined)).toBeNull();
    expect(decodeWindowAttr("")).toBeNull();
    expect(decodeWindowAttr("system=12:1;memory=4:1")).toBeNull();
    expect(decodeWindowAttr("system=12:1;system=4:1")).toBeNull();
    expect(decodeWindowAttr("system=12")).toBeNull();
    expect(decodeWindowAttr("system=-1:1")).toBeNull();
  });
});

describe("apportionWindowTokens", () => {
  it("gives each block its byte share and sums to the vendor's total", () => {
    const blocks: ContextWindowBlock[] = [
      { kind: "system", bytes: 1, items: 1 },
      { kind: "tools", bytes: 1, items: 1 },
      { kind: "conversation", bytes: 1, items: 1 },
    ];
    const tokens = apportionWindowTokens(100, blocks);
    // 33.3 each: the one token left goes to the earliest block.
    expect(tokens).toEqual([34, 33, 33]);
    expect(tokens.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("hands the remainder to the largest fractions first", () => {
    const blocks: ContextWindowBlock[] = [
      { kind: "system", bytes: 10, items: 1 },
      { kind: "tools", bytes: 25, items: 3 },
      { kind: "conversation", bytes: 65, items: 9 },
    ];
    // 7 × 0.10 = 0.7, 7 × 0.25 = 1.75, 7 × 0.65 = 4.55.
    expect(apportionWindowTokens(7, blocks)).toEqual([1, 2, 4]);
  });

  it("sums to the total for a large prompt", () => {
    const blocks: ContextWindowBlock[] = [
      { kind: "system", bytes: 13_331, items: 1 },
      { kind: "steering", bytes: 4_097, items: 1 },
      { kind: "tools", bytes: 91_003, items: 61 },
      { kind: "context", bytes: 7_777, items: 2 },
      { kind: "conversation", bytes: 1_200_113, items: 180 },
    ];
    const tokens = apportionWindowTokens(412_389, blocks);
    expect(tokens.reduce((a, b) => a + b, 0)).toBe(412_389);
    expect(tokens.every((t) => t >= 0)).toBe(true);
  });

  it("gives every block zero when the window measured no bytes", () => {
    expect(
      apportionWindowTokens(50, [{ kind: "system", bytes: 0, items: 0 }]),
    ).toEqual([0]);
  });
});

describe("windowBlockOf", () => {
  it("sums each part's JSON length and counts the parts", () => {
    expect(windowBlockOf("tools", [{ a: 1 }, "é"])).toEqual({
      kind: "tools",
      bytes: windowJsonBytes({ a: 1 }) + 4,
      items: 2,
    });
  });
});
