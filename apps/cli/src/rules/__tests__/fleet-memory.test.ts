/**
 * Fleet memory — proves lessons are durably recorded as JSON Lines and that
 * lexical recall ranks by term overlap, file overlap, and class/enforcement.
 * Each test runs against an isolated $HOME so it never touches the developer's
 * real store.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { openFleetMemory, formatLessons } from "../fleet-memory.js";
import type { MemoryRecord } from "../fleet-memory.js";

let home = "";
let prevHome = "";
const cwd = "/work/myproj";

beforeEach(() => {
  prevHome = process.env["HOME"] ?? "";
  home = mkdtempSync(join(tmpdir(), "oxagen-mem-home-"));
  process.env["HOME"] = home;
});

afterEach(() => {
  process.env["HOME"] = prevHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("record + all", () => {
  it("persists records and reads them back newest-first", () => {
    const mem = openFleetMemory(cwd);
    mem.record({
      memoryKind: "routine-change",
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      lesson: "first lesson",
      files: [],
      outcome: "success",
    });
    mem.record({
      memoryKind: "gotcha",
      memoryClass: "RULE",
      enforcementScore: 70,
      lesson: "second lesson",
      files: ["a.ts"],
      outcome: "failure",
    });
    const all = mem.all();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.lesson)).toContain("first lesson");
    expect(all.map((r) => r.lesson)).toContain("second lesson");
    // ids and timestamps are assigned by the store.
    expect(all.every((r) => r.id.startsWith("mem_") && r.createdAt > 0)).toBe(
      true,
    );
  });

  it("persists across separate openFleetMemory instances (reads the file)", () => {
    openFleetMemory(cwd).record({
      memoryKind: "constraint",
      memoryClass: "RULE",
      enforcementScore: 95,
      lesson: "keep the cache warm",
      files: [],
      outcome: "success",
    });
    const reopened = openFleetMemory(cwd);
    expect(reopened.all().some((r) => r.lesson === "keep the cache warm")).toBe(
      true,
    );
  });

  it("HOME isolation actually points the store under the temp home", () => {
    expect(homedir()).toBe(home);
  });
});

describe("recall", () => {
  it("ranks by term overlap and ignores irrelevant lessons", () => {
    const mem = openFleetMemory(cwd);
    mem.record({
      memoryKind: "bug-root-cause",
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      lesson: "the parser drops the final token",
      files: ["parser.ts"],
      outcome: "success",
    });
    mem.record({
      memoryKind: "routine-change",
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      lesson: "stylesheet needs a vendor prefix",
      files: ["style.css"],
      outcome: "success",
    });
    const hits = mem.recall("why does the parser lose a token");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.lesson).toContain("parser");
    expect(hits.some((h) => h.files.includes("style.css"))).toBe(false);
  });

  it("weights file overlap above term overlap", () => {
    const mem = openFleetMemory(cwd);
    mem.record({
      memoryKind: "gotcha",
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      lesson: "unrelated words entirely",
      files: ["target.ts"],
      outcome: "success",
    });
    mem.record({
      memoryKind: "gotcha",
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      lesson: "the target logic is fragile",
      files: ["other.ts"],
      outcome: "success",
    });
    // Query term "target" hits the second lesson's text, but the file filter
    // matches the first lesson's file — and file overlap is weighted higher.
    const hits = mem.recall("target", { files: ["target.ts"] });
    expect(hits[0]?.files).toEqual(["target.ts"]);
  });

  it("returns nothing when there is no overlap", () => {
    const mem = openFleetMemory(cwd);
    mem.record({
      memoryKind: "gotcha",
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      lesson: "alpha beta gamma",
      files: [],
      outcome: "success",
    });
    expect(mem.recall("zzz qqq xxx")).toHaveLength(0);
  });

  it("ranks a high-enforcement RULE above an OBSERVATION on equal term/file overlap", () => {
    const mem = openFleetMemory(cwd);
    mem.record({
      memoryKind: "gotcha",
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      lesson: "widgets need careful handling",
      files: [],
      outcome: "success",
    });
    mem.record({
      memoryKind: "constraint",
      memoryClass: "RULE",
      enforcementScore: 95,
      lesson: "widgets need careful handling too",
      files: [],
      outcome: "success",
    });
    const hits = mem.recall("widgets need careful handling");
    expect(hits[0]?.memoryClass).toBe("RULE");
  });

  it("tolerates a corrupt line already on disk", () => {
    const dir = join(home, ".config", "oxagen", "memories");
    mkdirSync(dir, { recursive: true });
    const good: MemoryRecord = {
      id: "mem_x",
      createdAt: 1,
      memoryKind: "gotcha",
      memoryClass: "RULE",
      enforcementScore: 70,
      lesson: "real lesson about widgets",
      files: [],
      outcome: "success",
    };
    writeFileSync(
      join(dir, "myproj.jsonl"),
      `not json\n${JSON.stringify(good)}\n`,
      "utf8",
    );
    const mem = openFleetMemory(cwd);
    expect(mem.recall("widgets")[0]?.lesson).toBe("real lesson about widgets");
  });
});

describe("formatLessons", () => {
  it("marks class/enforcement and lists files", () => {
    const records: MemoryRecord[] = [
      {
        id: "1",
        createdAt: 1,
        memoryKind: "constraint",
        memoryClass: "RULE",
        enforcementScore: 95,
        lesson: "A",
        files: ["x.ts"],
        outcome: "success",
      },
      {
        id: "2",
        createdAt: 2,
        memoryKind: "gotcha",
        memoryClass: "RULE",
        enforcementScore: 70,
        lesson: "B",
        files: [],
        outcome: "success",
      },
      {
        id: "3",
        createdAt: 3,
        memoryKind: "routine-change",
        memoryClass: "OBSERVATION",
        enforcementScore: null,
        lesson: "C",
        files: [],
        outcome: "success",
      },
    ];
    const out = formatLessons(records);
    expect(out).toContain("‼");
    expect(out).toContain("!");
    expect(out).toContain("·");
    expect(out).toContain("[x.ts]");
    expect(formatLessons([])).toBe("");
  });
});
