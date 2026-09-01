/**
 * Coverage for the deterministic next-read predictor (ADR-030): each
 * heuristic's happy path, its refusal cases, and the prediction caps.
 */
import { describe, it, expect } from "vitest";
import {
  heuristicPredictor,
  MAX_PREDICTIONS_PER_OBSERVATION,
} from "./predictor";

describe("heuristicPredictor — read_file follow-ups", () => {
  it("predicts the ranged re-read first (near-certain), then the dependents impact query", () => {
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
      {
        tool: "read_file",
        input: { path: "src/big.ts", offset: 420, limit: 260 },
      },
      {
        tool: "code_graph",
        input: { operation: "dependents", query: "src/big.ts" },
      },
    ]);
  });

  it("predicts only the dependents impact query for an untruncated read", () => {
    expect(
      heuristicPredictor({
        tool: "read_file",
        input: { path: "a.ts" },
        result: "1\tconst x = 1;",
      }),
    ).toEqual([
      { tool: "code_graph", input: { operation: "dependents", query: "a.ts" } },
    ]);
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

describe("heuristicPredictor — search content hits", () => {
  it("predicts reads of the top distinct hit files, capped", () => {
    const result = [
      "src/a.ts:10:const a = 1;",
      "src/a.ts:20:const aa = 2;", // duplicate path — deduped
      "src/b.ts:3:const b = 3;",
      "src/c.ts:4:const c = 4;",
      "src/d.ts:5:const d = 5;", // beyond the cap
    ].join("\n");
    const predictions = heuristicPredictor({
      tool: "search",
      input: { query: "const" },
      result,
    });
    expect(predictions).toHaveLength(MAX_PREDICTIONS_PER_OBSERVATION);
    expect(predictions.map((p) => p.input["path"])).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    expect(new Set(predictions.map((p) => p.tool))).toEqual(
      new Set(["read_file"]),
    );
  });

  it("predicts nothing from a no-match result", () => {
    expect(
      heuristicPredictor({
        tool: "search",
        input: { query: "x" },
        result: "(no matches)",
      }),
    ).toEqual([]);
  });
});

describe("heuristicPredictor — search name-only matches", () => {
  it("predicts reads of bare path lines, modestly capped at two", () => {
    const result = ["src/a.ts", "src/b.ts", "src/c.ts"].join("\n");
    const predictions = heuristicPredictor({
      tool: "search",
      input: { query: ".ts" },
      result,
    });
    expect(predictions).toEqual([
      { tool: "read_file", input: { path: "src/a.ts" } },
      { tool: "read_file", input: { path: "src/b.ts" } },
    ]);
  });

  it("dedups a name line against a content hit for the same file", () => {
    const result = ["src/a.ts:4:const a = 1;", "src/a.ts", "src/b.ts"].join(
      "\n",
    );
    const predictions = heuristicPredictor({
      tool: "search",
      input: { query: "a" },
      result,
    });
    expect(predictions).toEqual([
      { tool: "read_file", input: { path: "src/a.ts" } },
      { tool: "read_file", input: { path: "src/b.ts" } },
    ]);
  });

  it("skips no-match and clip-marker lines", () => {
    expect(
      heuristicPredictor({
        tool: "search",
        input: { query: "x" },
        result: "(no matches)",
      }),
    ).toEqual([]);
    const clipped =
      "… [1234 chars truncated from the middle — head + tail kept]";
    expect(
      heuristicPredictor({
        tool: "search",
        input: { query: "x" },
        result: clipped,
      }),
    ).toEqual([]);
  });
});

describe("heuristicPredictor — code_graph result mining", () => {
  it("predicts reads of platform-format rows (path:line:), deduped and capped at two", () => {
    const result = [
      "src/dep1.ts:5: function useA",
      "src/dep1.ts:9: function useAA", // duplicate path — deduped
      "src/dep2.ts:3: class B",
      "src/dep3.ts:7: type C", // beyond the modest cap
    ].join("\n");
    expect(
      heuristicPredictor({
        tool: "code_graph",
        input: { operation: "search", query: "use" },
        result,
      }),
    ).toEqual([
      { tool: "read_file", input: { path: "src/dep1.ts" } },
      { tool: "read_file", input: { path: "src/dep2.ts" } },
    ]);
  });

  it("predicts reads from CLI em-dash rows, signature tail included", () => {
    const result = "function runTurn — src/agent/loop.ts:141 (opts: TurnOpts)";
    expect(
      heuristicPredictor({
        tool: "code_graph",
        input: { operation: "search", query: "runTurn" },
        result,
      }),
    ).toEqual([{ tool: "read_file", input: { path: "src/agent/loop.ts" } }]);
  });

  it("predicts reads of bare-path listing bodies and skips header lines", () => {
    const result = [
      "Files importing src/a.ts (3):", // header — has spaces, not a path
      "src/user1.ts",
      "src/user2.ts",
    ].join("\n");
    expect(
      heuristicPredictor({
        tool: "code_graph",
        input: { operation: "dependents", query: "src/a.ts" },
        result,
      }),
    ).toEqual([
      { tool: "read_file", input: { path: "src/user1.ts" } },
      { tool: "read_file", input: { path: "src/user2.ts" } },
    ]);
  });

  it("predicts reads from semantic-search scored rows — but never a semantic_search call", () => {
    const result = "src/config.ts (0.91)\nsrc/env.ts (0.87)";
    const predictions = heuristicPredictor({
      tool: "code_graph",
      input: { operation: "semantic_search", query: "project configuration" },
      result,
    });
    expect(predictions).toEqual([
      { tool: "read_file", input: { path: "src/config.ts" } },
      { tool: "read_file", input: { path: "src/env.ts" } },
    ]);
  });

  it("predicts nothing from unavailable/error parentheticals", () => {
    for (const result of [
      "(import graph not available for this connection — use grep to find references)",
      "(code graph query error: connection refused)",
      "",
    ]) {
      expect(
        heuristicPredictor({
          tool: "code_graph",
          input: { operation: "dependents", query: "src/a.ts" },
          result,
        }),
      ).toEqual([]);
    }
  });
});

describe("heuristicPredictor — semantic_search prefetch exclusion (regression)", () => {
  it("never predicts a code_graph operation other than dependents, for any observation", () => {
    const observations = [
      { tool: "read_file", input: { path: "src/a.ts" }, result: "1\tx" },
      { tool: "search", input: { query: "x" }, result: "src/a.ts:1:x" },
      { tool: "search", input: { query: "a" }, result: "src/a.ts" },
      {
        tool: "code_graph",
        input: { operation: "semantic_search", query: "config" },
        result: "src/config.ts (0.91)",
      },
      {
        tool: "code_graph",
        input: { operation: "search", query: "foo" },
        result: "src/a.ts:1: function foo",
      },
    ];
    for (const obs of observations) {
      for (const p of heuristicPredictor(obs)) {
        if (p.tool !== "code_graph") continue;
        expect(p.input["operation"]).toBe("dependents");
      }
    }
  });
});

describe("heuristicPredictor — everything else", () => {
  it("predicts nothing for list_dir and unknown tools", () => {
    expect(
      heuristicPredictor({ tool: "list_dir", input: {}, result: "a\nb" }),
    ).toEqual([]);
    expect(
      heuristicPredictor({
        tool: "bash",
        input: { command: "ls" },
        result: "a",
      }),
    ).toEqual([]);
  });
});

describe("heuristicPredictor — search output as the tool actually prints it", () => {
  // These three pin bugs found while migrating the tests to the unified
  // `search` tool: the arm was written against bare hit lines, but the real
  // output carries section headers and prints NAMES first.
  const realOutput = [
    "Files matching by name:",
    "src/auth/login.ts",
    "src/auth/session.ts",
    "",
    "Content matches:",
    "src/server.ts:42:  const token = login()",
    "src/router.ts:9:  login(req)",
  ].join("\n");

  it("never prefetches a section header as a file path", () => {
    const predictions = heuristicPredictor({
      tool: "search",
      input: { query: "login" },
      result: realOutput,
    });
    const paths = predictions.map((p) => (p.input as { path: string }).path);
    // "Files matching by name:" clears isPathLike — no leading paren, no NUL —
    // so the loose check spent read_file slots on strings that are not paths.
    expect(paths).not.toContain("Files matching by name:");
    expect(paths).not.toContain("Content matches:");
  });

  it("gives content hits the budget even though names print first", () => {
    const predictions = heuristicPredictor({
      tool: "search",
      input: { query: "login" },
      result: realOutput,
    });
    const paths = predictions.map((p) => (p.input as { path: string }).path);
    // Content hits carry line-level evidence; a line-order pass would have
    // let the earlier name section take every slot.
    expect(paths.slice(0, 2)).toEqual(["src/server.ts", "src/router.ts"]);
  });

  it("still mines name matches when there are no content hits", () => {
    const predictions = heuristicPredictor({
      tool: "search",
      input: { query: "login" },
      result: "Files matching by name:\nsrc/auth/login.ts\nsrc/auth/session.ts",
    });
    expect(predictions.map((p) => (p.input as { path: string }).path)).toEqual([
      "src/auth/login.ts",
      "src/auth/session.ts",
    ]);
  });
});
