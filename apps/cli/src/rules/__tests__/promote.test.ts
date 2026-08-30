/**
 * Memory→rule promotion — proves the miner clusters recurring judge findings
 * and salient fleet-memory lessons into ranked candidates, and that promoting
 * one writes exactly the frontmatter shape `loader.ts` reads back (so a
 * promoted rule behaves identically to a hand-authored one — Tier 1 in the
 * prompt, and Tier 2 via `guardsToDeny` when a guard was inferred). Also proves
 * the approval gate: nothing is ever written without explicit approval.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mineCandidates, promoteCandidate } from "../promote.js";
import { loadRules } from "../loader.js";
import { guardsToDeny } from "../enforce.js";
import type { Rule } from "../types.js";
import type { TurnTrace, JudgeVerdict } from "../../agent/trace.js";
import type { MemoryRecord } from "../../agent/fleet/memory.js";

function judge(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    complete: false,
    confidence: 80,
    findings: [],
    remainingWork: [],
    reasoning: "",
    model: "m",
    fallback: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ...over,
  };
}

/** A minimal, valid TurnTrace carrying one judge round with the given findings. */
function trace(
  id: string,
  findings: string[],
  over: Partial<TurnTrace> = {},
): TurnTrace {
  return {
    id,
    createdAt: 1000,
    cwd: "/proj",
    originalPrompt: "do work",
    evaluation: {
      completeness: 80,
      complexity: 40,
      recommendedTier: "balanced",
      missing: [],
      contextQueries: [],
      refinedPrompt: "do work",
      removed: [],
      reasoning: "",
      fallback: false,
      model: "m",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    },
    enhancement: {
      prompt: "do work",
      context: "",
      resolved: [],
      lessonCount: 0,
      source: "none",
    },
    selectedModel: "m",
    selectedTier: "balanced",
    selectionRationale: "",
    response: "done",
    filesTouched: [],
    commandsRun: [],
    judgeRounds: [judge({ findings, remainingWork: [] })],
    finalComplete: true,
    steps: 1,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    durationMs: 100,
    ...over,
  };
}

function memory(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_1",
    createdAt: 1,
    memoryKind: "gotcha",
    memoryClass: "OBSERVATION",
    enforcementScore: null,
    lesson: "lesson text",
    files: [],
    outcome: "success",
    ...over,
  };
}

describe("mineCandidates", () => {
  it("detects a lesson recurring across traces as a candidate, with evidence", () => {
    const traces = [
      trace("t1", ["forgot to add a test for the new route"]),
      trace("t2", ["forgot to add a test for the new route"]),
      trace("t3", ["forgot to add a test for the new route"]),
    ];
    const candidates = mineCandidates({ traces, memories: [] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe("forgot to add a test for the new route");
    expect(candidates[0]?.occurrences).toBe(3);
    expect(candidates[0]?.evidence).toHaveLength(3);
    expect(
      candidates[0]?.evidence.every((e) => e.ref.startsWith("trace:")),
    ).toBe(true);
  });

  it("does not surface a one-off finding below the occurrence threshold", () => {
    const traces = [trace("t1", ["one-off issue nobody else hit"])];
    expect(mineCandidates({ traces, memories: [] })).toHaveLength(0);
  });

  it("promotes a single high-salience memory regardless of occurrence count", () => {
    const memories = [
      memory({
        memoryClass: "FACT",
        enforcementScore: null,
        lesson: "database credentials leaked in a log line",
      }),
    ];
    const candidates = mineCandidates({ traces: [], memories });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.salient).toBe(true);
    expect(candidates[0]?.occurrences).toBe(1);
    expect(candidates[0]?.evidence[0]?.ref).toBe("memory:mem_1");
  });

  it("ranks a salient single memory above a merely-recurring finding", () => {
    const traces = [
      trace("t1", ["forgot to add a test for the new route"]),
      trace("t2", ["forgot to add a test for the new route"]),
      trace("t3", ["forgot to add a test for the new route"]),
    ];
    const memories = [
      memory({
        memoryClass: "FACT",
        enforcementScore: null,
        lesson: "database credentials leaked in a log line",
      }),
    ];
    const candidates = mineCandidates({ traces, memories });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.salient).toBe(true);
  });

  it("does not surface a candidate that duplicates an existing rule's text", () => {
    const traces = [
      trace("t1", ["never force-push to a shared branch"]),
      trace("t2", ["never force-push to a shared branch"]),
      trace("t3", ["never force-push to a shared branch"]),
    ];
    const existingRules: Rule[] = [
      {
        id: "no-force-push",
        description: "",
        text: "Never force-push to a shared branch.",
        source: "x",
      },
    ];
    expect(
      mineCandidates({ traces, memories: [], existingRules }),
    ).toHaveLength(0);
  });

  it("infers a deny-path guard from a recurring gotcha's consistent file evidence", () => {
    const memories = [
      memory({
        id: "m1",
        memoryClass: "RULE",
        enforcementScore: 95,
        lesson: "never edit an applied migration file directly",
        files: ["packages/database/migrations/0001-applied/up.sql"],
      }),
      memory({
        id: "m2",
        memoryClass: "RULE",
        enforcementScore: 95,
        lesson: "never edit an applied migration file directly",
        files: ["packages/database/migrations/0002-applied/up.sql"],
      }),
    ];
    const candidates = mineCandidates({ traces: [], memories });
    expect(candidates[0]?.guard).toEqual({
      denyPathGlob: "packages/database/migrations/**",
    });
  });

  it("leaves a candidate prompt-only when file evidence shares no common directory", () => {
    const memories = [
      memory({
        id: "m1",
        memoryClass: "RULE",
        enforcementScore: 95,
        lesson: "shared lesson text here",
        files: ["a/one.ts"],
      }),
      memory({
        id: "m2",
        memoryClass: "RULE",
        enforcementScore: 95,
        lesson: "shared lesson text here",
        files: ["b/two.ts"],
      }),
    ];
    const candidates = mineCandidates({ traces: [], memories });
    expect(candidates[0]?.guard).toBeUndefined();
  });
});

describe("promoteCandidate", () => {
  let dir: string;
  let rulesDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oxagen-rule-promote-"));
    rulesDir = join(dir, ".oxagen", "rules");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes an approved candidate as a rule file the existing loader parses back", () => {
    const traces = [
      trace("t1", ["forgot to add a test for the new route"]),
      trace("t2", ["forgot to add a test for the new route"]),
      trace("t3", ["forgot to add a test for the new route"]),
    ];
    const [candidate] = mineCandidates({ traces, memories: [] });
    expect(candidate).toBeDefined();

    const result = promoteCandidate(candidate!, {
      dir: rulesDir,
      approve: true,
    });
    expect(result.status).toBe("written");
    expect(existsSync(result.path)).toBe(true);

    const loaded = loadRules({
      cwd: dir,
      userRulesDir: join(dir, "user-rules"),
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(candidate!.id);
    expect(loaded[0]?.text).toBe("forgot to add a test for the new route");
    expect(loaded[0]?.description).toContain("3 recurring observations");
    expect(loaded[0]?.guard).toBeUndefined();
  });

  it("declines without writing anything when not approved", () => {
    const traces = [
      trace("t1", ["forgot to add a test for the new route"]),
      trace("t2", ["forgot to add a test for the new route"]),
      trace("t3", ["forgot to add a test for the new route"]),
    ];
    const [candidate] = mineCandidates({ traces, memories: [] });

    const result = promoteCandidate(candidate!, {
      dir: rulesDir,
      approve: false,
    });
    expect(result.status).toBe("declined");
    expect(existsSync(result.path)).toBe(false);
    expect(existsSync(rulesDir)).toBe(false); // declining never even creates the directory
    expect(
      loadRules({ cwd: dir, userRulesDir: join(dir, "user-rules") }),
    ).toHaveLength(0);
  });

  it("does not overwrite an already-promoted rule on re-promotion", () => {
    const traces = [
      trace("t1", ["repeated lesson about caching"]),
      trace("t2", ["repeated lesson about caching"]),
      trace("t3", ["repeated lesson about caching"]),
    ];
    const [candidate] = mineCandidates({ traces, memories: [] });

    const first = promoteCandidate(candidate!, {
      dir: rulesDir,
      approve: true,
    });
    expect(first.status).toBe("written");
    const second = promoteCandidate(candidate!, {
      dir: rulesDir,
      approve: true,
    });
    expect(second.status).toBe("already-exists");
  });

  it("writes a guarded candidate that guardsToDeny converts into a hard-block deny entry", () => {
    const memories = [
      memory({
        id: "m1",
        memoryClass: "RULE",
        enforcementScore: 95,
        lesson: "never edit an applied migration file directly",
        files: ["packages/database/migrations/0001-applied/up.sql"],
      }),
      memory({
        id: "m2",
        memoryClass: "RULE",
        enforcementScore: 95,
        lesson: "never edit an applied migration file directly",
        files: ["packages/database/migrations/0002-applied/up.sql"],
      }),
    ];
    const [candidate] = mineCandidates({ traces: [], memories });
    expect(candidate?.guard).toBeDefined();

    const result = promoteCandidate(candidate!, {
      dir: rulesDir,
      approve: true,
    });
    expect(result.status).toBe("written");

    const loaded = loadRules({
      cwd: dir,
      userRulesDir: join(dir, "user-rules"),
    });
    expect(loaded[0]?.guard).toEqual({
      denyPathGlob: "packages/database/migrations/**",
    });

    const { deny, reasons } = guardsToDeny(loaded);
    expect(deny).toContain("*(packages/database/migrations/**)");
    expect(Object.values(reasons)[0]).toContain(candidate!.id);
  });
});
