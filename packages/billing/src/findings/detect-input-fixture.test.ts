// detect-input-fixture.test.ts — the empty detector input a detector test
// starts from, and the overrides it takes.
import { describe, expect, it } from "vitest";
import type { RunTotalsRecord } from "../cost-rollup";
import {
  detectInputFixture,
  FIXTURE_WINDOW_END,
  FIXTURE_WINDOW_START,
} from "./detect-input-fixture";
import { detectFindings } from "./index";
import { FINDINGS_WINDOW_DAYS } from "./shared";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("detectInputFixture", () => {
  it("sets every read the store sets, empty", () => {
    const input = detectInputFixture();
    expect(input.window).toEqual({
      start: FIXTURE_WINDOW_START,
      end: FIXTURE_WINDOW_END,
    });
    expect(input.toolWindowStart).toEqual(FIXTURE_WINDOW_START);
    expect(input.runs).toEqual([]);
    expect(input.toolCalls).toEqual([]);
    expect(input.decidedSince.size).toBe(0);
    expect(input.frames.size).toBe(0);
    expect(input.firstPrompts.size).toBe(0);
    expect(input.fileChanges.size).toBe(0);
    expect(input.compactions.size).toBe(0);
    expect(input.outcomes.size).toBe(0);
    expect(input.frameCoverage).toEqual({
      runs: 0,
      read: 0,
      capped: 0,
      unmatched: 0,
    });
  });

  it("spans the findings window", () => {
    expect(FIXTURE_WINDOW_END.getTime() - FIXTURE_WINDOW_START.getTime()).toBe(
      FINDINGS_WINDOW_DAYS * DAY_MS,
    );
  });

  it("counts the runs it is given as read", () => {
    const runs = [
      { runId: "tse_a" },
      { runId: "tse_b" },
    ] as unknown as RunTotalsRecord[];
    expect(detectInputFixture({ runs }).frameCoverage).toEqual({
      runs: 2,
      read: 2,
      capped: 0,
      unmatched: 0,
    });
  });

  it("keeps an override over the default", () => {
    const fileChanges = new Map([["tse_a", true]]);
    const coverage = { runs: 3, read: 1, capped: 2, unmatched: 0 };
    const input = detectInputFixture({ fileChanges, frameCoverage: coverage });
    expect(input.fileChanges).toBe(fileChanges);
    expect(input.frameCoverage).toBe(coverage);
    expect(input.compactions.size).toBe(0);
  });

  it("returns fresh maps on each call", () => {
    expect(detectInputFixture().frames).not.toBe(detectInputFixture().frames);
  });

  it("runs every registered detector to no finding", () => {
    expect(detectFindings(detectInputFixture())).toEqual([]);
  });
});
