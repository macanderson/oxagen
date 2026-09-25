import type { TranscriptEntryBody } from "@oxagen/oxagen/contracts/run.transcript.get";
import { type RunFrame, stepFolds, tachoFrame } from "@oxagen/run-ledger";
import { describe, expect, it, vi } from "vitest";
import { tachoRow } from "../run.test-support";
import { searchableText, searchFolds } from "./transcript-search";

/** Columns of a body the recorder kept, named by `n`. */
const kept = (n: number) => ({
  contentDigest: `sha256:${String(n).padStart(64, "0")}`,
  bytesRef: `evb:v1:k:${String(n)}`,
});

/** A tool call's result frame, with a kept body. */
const result = (seq: number) =>
  tachoFrame(tachoRow(seq, { kind: "tool_call", ...kept(seq) }));

const half = (over: Partial<TranscriptEntryBody>): TranscriptEntryBody => ({
  seq: "1",
  type: "tool_call",
  digest: null,
  bytesRef: null,
  redactions: [],
  fidelity: "full",
  text: null,
  truncated: false,
  assembly: null,
  ...over,
});

const blockBase = { chars: 0, tokens: 0, partial: false, cost: null };

describe("searchableText", () => {
  it("is a half's text when it carries text", () => {
    expect(searchableText(half({ text: "RETRY_LIMIT = 3" }))).toBe(
      "RETRY_LIMIT = 3",
    );
    expect(searchableText(half({ text: "" }))).toBe("");
  });

  it("is what an assembled reply shows: words, thinking, each call and its input, each result", () => {
    const text = searchableText(
      half({
        assembly: {
          blocks: [
            {
              ...blockBase,
              id: "b0",
              kind: "thinking",
              text: "Look first.",
              truncated: false,
              seconds: null,
            },
            {
              ...blockBase,
              id: "b1",
              kind: "text",
              text: "Reading it now.",
              truncated: false,
            },
            {
              ...blockBase,
              id: "b2",
              kind: "tool_use",
              name: "Read",
              input: { path: "src/limits.ts" },
              inputRaw: false,
              inputFolded: false,
              callKey: "tu_1",
              verdict: null,
            },
            {
              ...blockBase,
              id: "b3",
              kind: "tool_use",
              name: "Bash",
              input: '{"command": "ls',
              inputRaw: true,
              inputFolded: false,
              callKey: null,
              verdict: null,
            },
            {
              ...blockBase,
              id: "b4",
              kind: "tool_result",
              forId: "b2",
              ok: true,
              summary: "12 lines",
              bytes: null,
              ms: null,
            },
          ],
          precis: "",
          stopReason: null,
          ttftMs: null,
          durationMs: null,
          tokensPerSecond: null,
          usage: {
            inputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            outputTokens: null,
          },
          partial: false,
          wire: { events: 0, bytes: 0 },
        },
      }),
    );
    expect(text).toBe(
      [
        "Look first.",
        "Reading it now.",
        'Read\n{"path":"src/limits.ts"}',
        'Bash\n{"command": "ls',
        "12 lines",
      ].join("\n"),
    );
  });

  it("is nothing for a half whose body was not kept or could not be read (negative)", () => {
    expect(searchableText(half({}))).toBeNull();
  });
});

describe("searchFolds", () => {
  const limits = { halfMax: 100, concurrency: 4 };

  it("reads at most its bound of halves, in entry order, and counts the rest as unsearched", async () => {
    const folds = stepFolds([result(0), result(1), result(2)]);
    const readText = vi.fn((_frame: RunFrame) => Promise.resolve("hit"));
    const out = await searchFolds(folds, "HIT", readText, {
      halfMax: 2,
      concurrency: 1,
    });
    expect(readText.mock.calls.map(([frame]) => frame.seq)).toEqual(["0", "1"]);
    expect(out.folds.map((fold) => fold.key)).toEqual(["0", "1"]);
    expect(out.search).toEqual({ query: "hit", matched: 2, unsearched: 1 });
  });

  it("still matches an entry past the bound on its label and tool", async () => {
    const folds = stepFolds([result(0), result(1)]);
    const out = await searchFolds(folds, "read", () => Promise.resolve(null), {
      halfMax: 0,
      concurrency: 1,
    });
    expect(out.folds).toHaveLength(2);
    expect(out.matches.get(out.folds[0] as (typeof folds)[number])).toEqual([
      "label",
      "subject",
    ]);
    // Both matched without their halves, so no half went unsearched.
    expect(out.search.unsearched).toBe(0);
  });

  it("counts a half the store could not answer as unsearched, and a half with no content not at all (negative)", async () => {
    const folds = stepFolds([
      result(0),
      tachoFrame(tachoRow(1, { kind: "tool_call" })),
    ]);
    const out = await searchFolds(
      folds,
      "anything",
      () => Promise.resolve(null),
      limits,
    );
    expect(out.folds).toEqual([]);
    expect(out.search).toEqual({
      query: "anything",
      matched: 0,
      unsearched: 1,
    });
  });

  it("keeps the order it was given, and each entry once however many places matched", async () => {
    const folds = stepFolds([result(0), result(1), result(2)]);
    const out = await searchFolds(
      folds,
      "hit",
      (frame) => Promise.resolve(frame.seq === "1" ? "a hit, a hit" : "no"),
      limits,
    );
    expect(out.folds.map((fold) => fold.key)).toEqual(["1"]);
    expect(out.matches.get(out.folds[0] as (typeof folds)[number])).toEqual([
      "response",
    ]);
  });

  it("reads no half of an entry that matched on its label, tool or target, and spends no bound on it", async () => {
    // Every call is to the Read tool, so every entry matches on its tool.
    const folds = stepFolds([result(0), result(1), result(2)]);
    const readText = vi.fn((_frame: RunFrame) => Promise.resolve("read"));
    const out = await searchFolds(folds, "read", readText, {
      halfMax: 1,
      concurrency: 1,
    });
    expect(readText).not.toHaveBeenCalled();
    expect(out.folds.map((fold) => fold.key)).toEqual(["0", "1", "2"]);
    expect(out.matches.get(out.folds[0] as (typeof folds)[number])).toEqual([
      "label",
      "subject",
    ]);
    // Their halves were not needed, so none is counted as unsearched.
    expect(out.search).toEqual({ query: "read", matched: 3, unsearched: 0 });
  });

  it("still reads the halves of an entry the label, tool and target do not hold (negative)", async () => {
    const folds = stepFolds([result(0), result(1)]);
    const readText = vi.fn((frame: RunFrame) =>
      Promise.resolve(frame.seq === "1" ? "RETRY_LIMIT = 3" : "nothing"),
    );
    const out = await searchFolds(folds, "retry", readText, limits);
    expect(readText.mock.calls.map(([frame]) => frame.seq)).toEqual(["0", "1"]);
    expect(out.folds.map((fold) => fold.key)).toEqual(["1"]);
  });
});
