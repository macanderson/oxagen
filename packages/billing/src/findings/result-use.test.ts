import { describe, expect, it } from "vitest";
import {
  chainVerdicts,
  MIN_QUOTE_CHARS,
  quoteIndex,
  quotes,
  resultUseKey,
  textValues,
  type ChainFrame,
} from "./result-use";

const LINE = "export function chainVerdicts(frames: readonly ChainFrame[]) {";
const PATH = "/home/agent/repo/packages/billing/src/findings/result-use.ts";

/** A tool call's body, as the hook stores it. */
function callBody(input: unknown, output?: unknown): string {
  return JSON.stringify(output === undefined ? { input } : { input, output });
}

function index(result: unknown, input: unknown = {}) {
  const i = quoteIndex(textValues(result), textValues(input));
  if (i === null) throw new Error("result has no quotable value");
  return i;
}

describe("textValues", () => {
  it("collects string values depth first and leaves out keys and numbers", () => {
    expect(
      textValues({ file: { filePath: PATH, content: LINE, numLines: 1 } }),
    ).toEqual([PATH, LINE]);
  });

  it("reads JSON inside a string as the values it holds", () => {
    const mcp = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ items: [{ title: "Fix the cache" }] }),
        },
      ],
    };
    expect(textValues(mcp)).toEqual(["text", "Fix the cache"]);
  });
});

describe("quotes", () => {
  it("finds a quote of a line the result holds, with its whitespace changed", () => {
    const result = index({ content: `const a = 1;\n    ${LINE}\n}` });
    expect(quotes(result, [`Replace   ${LINE.replace(/ /g, "\n")} here`])).toBe(
      true,
    );
  });

  it(`counts a shared run of ${MIN_QUOTE_CHARS} characters and not one of ${MIN_QUOTE_CHARS - 1}`, () => {
    const text =
      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const result = index({ content: text });
    expect(quotes(result, [`>${text.slice(3, 3 + MIN_QUOTE_CHARS)}<`])).toBe(
      true,
    );
    expect(
      quotes(result, [`>${text.slice(3, 3 + MIN_QUOTE_CHARS - 1)}<`]),
    ).toBe(false);
  });

  it("does not count a run the result's own call input also holds", () => {
    // A read echoes the path it was given. A later edit of the same file
    // names that path without needing the result.
    const result = index(
      { file: { filePath: PATH, content: LINE } },
      { file_path: PATH },
    );
    expect(quotes(result, [PATH])).toBe(false);
    expect(quotes(result, [PATH, LINE])).toBe(true);
  });

  it("does not join two values into one quote", () => {
    const head = "a".repeat(25);
    const tail = "b".repeat(25);
    const result = index({ a: head, b: tail, c: LINE });
    expect(quotes(result, [`${head} ${tail}`])).toBe(false);
  });

  it("indexes no result whose values are all shorter than a quote", () => {
    expect(
      quoteIndex(textValues({ ids: ["issue-4506", "issue-4585"] }), []),
    ).toBeNull();
  });
});

describe("chainVerdicts", () => {
  const RESULT = "run|chain|1";

  function result(
    at: number,
    output: unknown,
    input: unknown = {},
  ): ChainFrame {
    return {
      atMicros: at,
      seq: at,
      kind: "call",
      body: callBody(input, output),
      resultKey: RESULT,
    };
  }

  function later(at: number, input: unknown): ChainFrame {
    return { atMicros: at, seq: at, kind: "call", body: callBody(input) };
  }

  function output(at: number, text: string | null): ChainFrame {
    return { atMicros: at, seq: at, kind: "output", body: text };
  }

  it("marks a result used when a later call's input quotes it", () => {
    expect(
      chainVerdicts([
        result(1, { content: LINE }),
        later(2, { old_string: LINE }),
        output(3, "Done."),
      ]),
    ).toEqual(new Map([[RESULT, "used"]]));
  });

  it("marks a result used when the agent's own text quotes it", () => {
    expect(
      chainVerdicts([
        result(1, { content: LINE }),
        output(2, `The file starts with ${LINE}`),
      ]),
    ).toEqual(new Map([[RESULT, "used"]]));
  });

  it("marks a result unused when every later step read back and none quoted it", () => {
    expect(
      chainVerdicts([
        result(1, { content: LINE }),
        later(2, { command: "ls" }),
        output(3, "Nothing to change."),
      ]),
    ).toEqual(new Map([[RESULT, "unused"]]));
  });

  it("gives no verdict when a later step's body did not read back", () => {
    expect(
      chainVerdicts([
        result(1, { content: LINE }),
        { atMicros: 2, seq: 2, kind: "call", body: null },
        output(3, "Done."),
      ]),
    ).toEqual(new Map());
    expect(
      chainVerdicts([result(1, { content: LINE }), output(2, null)]),
    ).toEqual(new Map());
  });

  it("gives no verdict when the chain holds no text the agent wrote after the result", () => {
    expect(
      chainVerdicts([
        result(1, { content: LINE }),
        later(2, { command: "ls" }),
      ]),
    ).toEqual(new Map());
  });

  it("gives no verdict when the result's own body did not read back", () => {
    expect(
      chainVerdicts([
        { ...result(1, { content: LINE }), body: null },
        later(2, { old_string: LINE }),
        output(3, "Done."),
      ]),
    ).toEqual(new Map());
  });

  it("checks only the steps after the result, by time and then by position", () => {
    // The agent's text before the call names the line, and nothing after it
    // does. Frames arrive out of order.
    expect(
      chainVerdicts([
        later(3, { command: "ls" }),
        result(1, { content: LINE }),
        output(4, "Done."),
        output(0, `Read the file that holds ${LINE}`),
      ]),
    ).toEqual(new Map([[RESULT, "unused"]]));
  });

  it("keys a result by its run, its chain, and its position", () => {
    expect(resultUseKey({ runId: "tse_1", sessionUuid: null, seq: 7 })).toBe(
      "tse_1||7",
    );
    expect(resultUseKey({ runId: "tse_1", sessionUuid: "s", seq: 7 })).toBe(
      "tse_1|s|7",
    );
  });
});
