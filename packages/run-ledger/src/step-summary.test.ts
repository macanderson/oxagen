import { describe, expect, it } from "vitest";
import type { AssemblyUsage, ContentBlock } from "./content-blocks";
import {
  clauseOf,
  nameList,
  pastTense,
  PRECIS_MAX,
  precisOf,
  summarizeStep,
} from "./step-summary";

function text(id: string, body: string): ContentBlock {
  return { kind: "text", id, text: body, chars: body.length, tokens: 10, partial: false };
}

function tool(id: string, name: string): ContentBlock {
  return {
    kind: "tool_use",
    id,
    name,
    input: {},
    inputRaw: false,
    callKey: null,
    verdict: null,
    chars: 20,
    tokens: 5,
    partial: false,
  };
}

const NO_USAGE: AssemblyUsage = {
  inputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
};

describe("pastTense", () => {
  it("uses the irregular form where there is one", () => {
    expect(pastTense("write")).toBe("wrote");
    expect(pastTense("read")).toBe("read");
    expect(pastTense("run")).toBe("ran");
    expect(pastTense("think")).toBe("thought");
  });

  it("applies the regular rules otherwise", () => {
    expect(pastTense("check")).toBe("checked");
    expect(pastTense("update")).toBe("updated");
    expect(pastTense("verify")).toBe("verified");
    expect(pastTense("plan")).toBe("planned");
    expect(pastTense("played")).toBe("played");
  });

  it("leaves a word the rules cannot read alone", () => {
    expect(pastTense("`npm`")).toBe("`npm`");
  });
});

describe("clauseOf", () => {
  it("drops the first-person lead-in and puts the verb in the past", () => {
    expect(clauseOf("I'll write the filing plan.")).toBe("Wrote the filing plan");
    expect(clauseOf("Let me check the handler.")).toBe("Checked the handler");
    expect(clauseOf("Now I'm going to run the tests.")).toBe("Ran the tests");
  });

  it("answers null for a sentence with no verb to take", () => {
    expect(clauseOf("...")).toBeNull();
    expect(clauseOf("42 is the count.")).toBeNull();
  });
});

describe("nameList", () => {
  it("joins names the way a person reads them", () => {
    expect(nameList([])).toBe("");
    expect(nameList(["Write"])).toBe("Write");
    expect(nameList(["Write", "Bash"])).toBe("Write and Bash");
    expect(nameList(["Write", "Bash", "Read"])).toBe("Write, Bash and Read");
  });
});

describe("precisOf", () => {
  it("builds the line from the first sentence and the tools asked for", () => {
    expect(
      precisOf([
        text("b0", "I'll write the filing plan.\n\nMore detail follows."),
        tool("b1", "Write"),
        tool("b2", "Bash"),
      ]),
    ).toBe("Wrote the filing plan, then asked for Write and Bash.");
  });

  it("names each tool once, however many times it was called", () => {
    expect(
      precisOf([text("b0", "Let me read the files."), tool("b1", "Read"), tool("b2", "Read")]),
    ).toBe("Read the files, then asked for Read.");
  });

  it("falls back to a line count when there is no usable sentence", () => {
    expect(precisOf([text("b0", "- one\n- two\n- three")])).toBe("Wrote 3 lines.");
  });

  it("leads with the tools when the step said nothing", () => {
    expect(precisOf([tool("b0", "Grep")])).toBe("Asked for Grep.");
  });

  it("says so when a step returned no content at all", () => {
    expect(precisOf([])).toBe("Returned no content.");
  });

  it("stays one line: never longer than the ceiling, never cut mid-word", () => {
    const whole =
      "Reconciled every recorded frame against the chain head before the seal is written, then asked for Write.";
    const line = precisOf([
      text(
        "b0",
        "I'll reconcile every recorded frame against the chain head before the seal is written.",
      ),
      tool("b1", "Write"),
    ]);

    expect(line.length).toBeLessThanOrEqual(PRECIS_MAX);
    expect(line.endsWith("…")).toBe(true);
    // The kept part is a whole-word prefix of the line it stands for: the cut
    // lands on a space, never inside a word.
    const kept = line.slice(0, -1);
    expect(whole.startsWith(kept)).toBe(true);
    expect(whole.charAt(kept.length)).toBe(" ");
  });

  it("is deterministic: the same blocks give the same line", () => {
    const blocks = [text("b0", "I'll update the contract."), tool("b1", "Edit")];
    expect(precisOf(blocks)).toBe(precisOf(blocks));
  });
});

describe("summarizeStep", () => {
  it("reports the rate from the reported output tokens and the wall time", () => {
    const summary = summarizeStep(
      [text("b0", "I'll update the contract."), tool("b1", "Edit")],
      { ...NO_USAGE, outputTokens: 250 },
      { ttftMs: 300, durationMs: 5000 },
    );

    expect(summary.precis).toBe("Updated the contract, then asked for Edit.");
    expect(summary.tokensPerSecond).toBe(50);
    expect(summary.ttftMs).toBe(300);
    expect(summary.durationMs).toBe(5000);
  });

  it("leaves the rate out rather than drawing a zero when a figure is missing", () => {
    expect(
      summarizeStep([text("b0", "x")], NO_USAGE, { ttftMs: null, durationMs: 4000 })
        .tokensPerSecond,
    ).toBeNull();
    expect(
      summarizeStep([text("b0", "x")], { ...NO_USAGE, outputTokens: 10 }, {
        ttftMs: null,
        durationMs: null,
      }).tokensPerSecond,
    ).toBeNull();
  });

  it("prices each block at the model's output rate", () => {
    const summary = summarizeStep(
      [text("b0", "hello"), tool("b1", "Edit")],
      { ...NO_USAGE, outputTokens: 15 },
      { ttftMs: null, durationMs: null },
      3_000_000,
    );

    expect(summary.blocks).toEqual([
      { id: "b0", kind: "text", tokens: 10, chars: 5, costMicros: 30 },
      { id: "b1", kind: "tool_use", tokens: 5, chars: 20, costMicros: 15 },
    ]);
  });

  it("leaves a block's cost out when the book priced no output for the model", () => {
    const summary = summarizeStep([text("b0", "hello")], NO_USAGE, {
      ttftMs: null,
      durationMs: null,
    });

    expect(summary.blocks[0]?.costMicros).toBeNull();
  });
});
