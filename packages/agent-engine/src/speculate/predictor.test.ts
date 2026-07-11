/**
 * Coverage for the deterministic next-read predictor (ADR-030): each
 * heuristic's happy path, its refusal cases, and the prediction caps.
 */
import { describe, it, expect } from "vitest";
import {
  heuristicPredictor,
  MAX_PREDICTIONS_PER_OBSERVATION,
} from "./predictor";

describe("heuristicPredictor — read_file truncation follow-up", () => {
  it("predicts the exact ranged re-read the truncation marker suggests", () => {
    const result =
      "1\tfoo\n… [truncated: file has 900 lines total, showing ~first 420 " +
      "and last 220 lines — call read_file with offset:420, limit:260 to fetch " +
      "the elided middle]\n899\tbar";
    const predictions = heuristicPredictor({
      tool: "read_file",
      input: { path: "src/big.ts" },
      result,
    });
    expect(predictions).toEqual([
      { tool: "read_file", input: { path: "src/big.ts", offset: 420, limit: 260 } },
    ]);
  });

  it("predicts nothing for an untruncated read", () => {
    expect(
      heuristicPredictor({
        tool: "read_file",
        input: { path: "a.ts" },
        result: "1\tconst x = 1;",
      }),
    ).toEqual([]);
  });

  it("predicts nothing when the input has no string path", () => {
    expect(
      heuristicPredictor({
        tool: "read_file",
        input: {},
        result: "… call read_file with offset:5, limit:9 …",
      }),
    ).toEqual([]);
  });
});

describe("heuristicPredictor — grep hits", () => {
  it("predicts reads of the top distinct hit files, capped", () => {
    const result = [
      "src/a.ts:10:const a = 1;",
      "src/a.ts:20:const aa = 2;", // duplicate path — deduped
      "src/b.ts:3:const b = 3;",
      "src/c.ts:4:const c = 4;",
      "src/d.ts:5:const d = 5;", // beyond the cap
    ].join("\n");
    const predictions = heuristicPredictor({
      tool: "grep",
      input: { pattern: "const" },
      result,
    });
    expect(predictions).toHaveLength(MAX_PREDICTIONS_PER_OBSERVATION);
    expect(predictions.map((p) => p.input["path"])).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    expect(new Set(predictions.map((p) => p.tool))).toEqual(new Set(["read_file"]));
  });

  it("predicts nothing from a no-match result", () => {
    expect(
      heuristicPredictor({ tool: "grep", input: { pattern: "x" }, result: "(no matches)" }),
    ).toEqual([]);
  });
});

describe("heuristicPredictor — glob listings", () => {
  it("predicts reads of the first entries, modestly capped at two", () => {
    const result = ["src/a.ts", "src/b.ts", "src/c.ts"].join("\n");
    const predictions = heuristicPredictor({
      tool: "glob",
      input: { pattern: "src/**/*.ts" },
      result,
    });
    expect(predictions).toEqual([
      { tool: "read_file", input: { path: "src/a.ts" } },
      { tool: "read_file", input: { path: "src/b.ts" } },
    ]);
  });

  it("skips no-match and clip-marker lines", () => {
    expect(
      heuristicPredictor({ tool: "glob", input: { pattern: "x" }, result: "(no matches)" }),
    ).toEqual([]);
    const clipped = "… [1234 chars truncated from the middle — head + tail kept]";
    expect(
      heuristicPredictor({ tool: "glob", input: { pattern: "x" }, result: clipped }),
    ).toEqual([]);
  });
});

describe("heuristicPredictor — everything else", () => {
  it("predicts nothing for list_dir and unknown tools", () => {
    expect(
      heuristicPredictor({ tool: "list_dir", input: {}, result: "a\nb" }),
    ).toEqual([]);
    expect(
      heuristicPredictor({ tool: "bash", input: { command: "ls" }, result: "a" }),
    ).toEqual([]);
  });
});
