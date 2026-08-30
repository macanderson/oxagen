/**
 * Verbose log stream — proves the JSONL "prove it" artifact round-trips: each
 * turn appends one line, reads back as a structured record, and a corrupt line
 * is skipped rather than failing the whole read.
 */
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect, vi } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "oxa-vlog-"));

// Point homedir() at a throwaway dir so the log lands somewhere disposable.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

import {
  appendVerboseLog,
  readVerboseLog,
  verboseLogPath,
} from "../verbose-log.js";
import type { TurnTrace } from "../trace.js";

function trace(id: string): TurnTrace {
  return {
    id,
    createdAt: 1,
    cwd: "/proj",
    originalPrompt: "do a thing",
    evaluation: {
      completeness: 50,
      complexity: 50,
      recommendedTier: "balanced",
      missing: [],
      contextQueries: [],
      refinedPrompt: "do a thing",
      removed: [],
      reasoning: "",
      fallback: false,
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
    },
    enhancement: {
      prompt: "p",
      context: "",
      resolved: [],
      lessonCount: 0,
      source: "none",
    },
    selectedModel: "anthropic/claude-sonnet-5",
    selectedTier: "balanced",
    selectionRationale: "r",
    response: "ok",
    filesTouched: [],
    commandsRun: [],
    judgeRounds: [],
    finalComplete: true,
    steps: 1,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    durationMs: 1234,
    verbose: true,
  };
}

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("verbose log", () => {
  it("appends each turn as JSONL and reads it back as structured records", () => {
    appendVerboseLog("/proj", trace("turn_a"));
    appendVerboseLog("/proj", trace("turn_b"));
    const records = readVerboseLog("/proj");
    expect(records.map((r) => r.id)).toEqual(["turn_a", "turn_b"]);
    expect(records[0]?.usage.costUsd).toBe(0.01);
    expect(records[0]?.verbose).toBe(true);
  });

  it("skips a corrupt line instead of failing the whole read", () => {
    appendFileSync(verboseLogPath("/proj"), "{not valid json\n", "utf8");
    appendVerboseLog("/proj", trace("turn_c"));
    const ids = readVerboseLog("/proj").map((r) => r.id);
    expect(ids).toContain("turn_c");
    expect(ids).not.toContain(undefined);
  });
});
