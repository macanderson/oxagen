/**
 * One bad transcript must not turn into an unexplained number (#2556).
 *
 * `parseAllFiles` isolates a file that throws — a truncated JSONL from a
 * crashed session, a hand-edited line — from the rest of the scan. Before
 * this test the isolating `catch` threw the file path and the error message
 * away and kept only a count, so a backfill run that printed "Parsed 40
 * files, 3 errors" gave the operator nothing to act on short of re-running
 * under a debugger to rediscover which three and why.
 */
import { describe, expect, it } from "vitest";
import { parseAllFiles, type FileRef } from "./backfill-claude-telemetry.js";
import type { ClaudeSessionRow } from "./backfill-claude-telemetry.js";

describe("parseAllFiles (#2556)", () => {
  it("names the file and keeps the error message for a failing parse", async () => {
    const files: FileRef[] = [
      { path: "/home/mac/.claude/projects/x/good.jsonl", isSubagent: false },
      {
        path: "/home/mac/.claude/projects/x/truncated.jsonl",
        isSubagent: false,
      },
    ];
    const lines: string[] = [];

    const summary = await parseAllFiles(
      files,
      async (path) => {
        if (path.endsWith("truncated.jsonl")) {
          throw new Error("Unexpected end of JSON input");
        }
        return [{ session_id: "s1" } as unknown as ClaudeSessionRow];
      },
      (line) => lines.push(line),
    );

    expect(summary.ok).toBe(1);
    expect(summary.fail).toBe(1);
    expect(summary.failures).toEqual([
      {
        path: "/home/mac/.claude/projects/x/truncated.jsonl",
        message: "Unexpected end of JSON input",
      },
    ]);
    // The old behavior only ever incremented a counter — nothing written for
    // a failing file. The fix must write a line naming it, not just tally it.
    expect(lines.some((l) => l.includes("truncated.jsonl"))).toBe(true);
    expect(
      lines.some((l) => l.includes("Unexpected end of JSON input")),
    ).toBe(true);
  });

  it("does not lose rows already parsed before a later file fails", async () => {
    const files: FileRef[] = [
      { path: "/a.jsonl", isSubagent: false },
      { path: "/b.jsonl", isSubagent: true },
    ];

    const summary = await parseAllFiles(
      files,
      async (path, isSubagent) => {
        if (isSubagent) throw new Error("boom");
        return [
          { session_id: "kept" } as unknown as ClaudeSessionRow,
        ];
      },
      () => {},
    );

    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({ session_id: "kept" });
    expect(summary.fail).toBe(1);
    expect(summary.failures[0]?.path).toBe("/b.jsonl");
  });

  it("stringifies a non-Error throw rather than dropping it", async () => {
    const files: FileRef[] = [{ path: "/weird.jsonl", isSubagent: false }];

    const summary = await parseAllFiles(
      files,
      async () => {
         
        throw "not an Error instance";
      },
      () => {},
    );

    expect(summary.failures).toEqual([
      { path: "/weird.jsonl", message: "not an Error instance" },
    ]);
  });
});
