import { describe, expect, it } from "vitest";
import type { WorkFile } from "../types";
import {
  type AutonomyEventRow,
  autonomyLevelFor,
  latestEventsByScope,
  levelInForce,
  parseAutonomyScope,
  scopeKey,
  scopeMatches,
} from "./scope";

const DOCS = { label: "Documentation" };
const BILLING = { repo: "aintel/billing-service", paths: ["src/**"] };

const WORK: Pick<WorkFile, "autonomy"> = {
  autonomy: [
    { scope: DOCS, level: 2, operator: "priya", max_daily_usd: 40 },
    { scope: BILLING, level: 1, operator: "sam", max_daily_usd: 120 },
  ],
};

function event(scope: unknown, toLevel: number, at: string): AutonomyEventRow {
  return { scope, toLevel, createdAt: new Date(at) };
}

describe("parseAutonomyScope", () => {
  it("reads a label scope and a repository scope with or without paths", () => {
    expect(parseAutonomyScope({ label: "Documentation" })).toEqual({ label: "Documentation" });
    expect(parseAutonomyScope({ repo: "aintel/web" })).toEqual({ repo: "aintel/web" });
    expect(parseAutonomyScope({ repo: "aintel/web", paths: ["docs/**"] })).toEqual({
      repo: "aintel/web",
      paths: ["docs/**"],
    });
  });

  it.each([
    ["null", null],
    ["a string", "label:Documentation"],
    ["an array", [{ label: "Documentation" }]],
    ["an empty label", { label: "  " }],
    ["a label with another key", { label: "Documentation", repo: "aintel/web" }],
    ["a label that is not a string", { label: 7 }],
    ["an empty repository", { repo: "" }],
    ["a repository with an unknown key", { repo: "aintel/web", branch: "main" }],
    ["paths that are not a list", { repo: "aintel/web", paths: "docs/**" }],
    ["an empty path list", { repo: "aintel/web", paths: [] }],
    ["an empty path", { repo: "aintel/web", paths: ["docs/**", ""] }],
    ["a path that is not a string", { repo: "aintel/web", paths: [3] }],
  ])("refuses %s", (_name, value) => {
    expect(parseAutonomyScope(value)).toBeNull();
  });
});

describe("scopeKey", () => {
  it("names a label with its case, and a repository without case", () => {
    expect(scopeKey({ label: "Documentation" })).toBe("label:Documentation");
    expect(scopeKey({ repo: "Aintel/Web" })).toBe("repo:aintel/web");
  });

  it("names the same globs in any order the same way", () => {
    const a = scopeKey({ repo: "aintel/web", paths: ["src/**", "docs/**", "src/**"] });
    expect(a).toBe('repo:aintel/web:["docs/**","src/**"]');
    expect(scopeKey({ repo: "aintel/web", paths: ["docs/**", "src/**"] })).toBe(a);
  });
});

describe("scopeMatches", () => {
  it("matches a label exactly", () => {
    expect(scopeMatches(DOCS, { labels: ["Bug", "Documentation"] })).toBe(true);
    expect(scopeMatches(DOCS, { labels: ["documentation"] })).toBe(false);
  });

  it("matches a repository without case", () => {
    expect(scopeMatches({ repo: "aintel/web" }, { labels: [], repo: "Aintel/Web" })).toBe(true);
    expect(scopeMatches({ repo: "aintel/web" }, { labels: [], repo: "aintel/api" })).toBe(false);
    expect(scopeMatches({ repo: "aintel/web" }, { labels: [] })).toBe(false);
  });

  it("matches a path scope when any touched path falls under any glob", () => {
    const target = { labels: [], repo: "aintel/billing-service" };
    expect(scopeMatches(BILLING, { ...target, paths: ["README.md", "src/invoice.ts"] })).toBe(true);
    expect(scopeMatches(BILLING, { ...target, paths: ["README.md"] })).toBe(false);
  });

  it("cannot decide a path scope before the touched paths are known", () => {
    const target = { labels: [], repo: "aintel/billing-service" };
    expect(scopeMatches(BILLING, target)).toBe("undecided");
    expect(scopeMatches(BILLING, { ...target, paths: [] })).toBe("undecided");
  });
});

describe("levelInForce", () => {
  it("is the file's level with no lowering", () => {
    expect(levelInForce(2, null)).toBe(2);
  });

  it("is the lower of the file and the latest lowering", () => {
    expect(levelInForce(2, { toLevel: 1 })).toBe(1);
    expect(levelInForce(1, { toLevel: 3 })).toBe(1);
  });

  it("counts a lowering outside 0 to 3 as 0", () => {
    expect(levelInForce(2, { toLevel: 7 })).toBe(0);
    expect(levelInForce(2, { toLevel: -1 })).toBe(0);
  });
});

describe("latestEventsByScope", () => {
  it("keeps the newest event for each scope and skips a row with no readable scope", () => {
    const events = [
      event(DOCS, 1, "2026-09-20T00:00:00Z"),
      event({ label: "Documentation" }, 0, "2026-09-28T00:00:00Z"),
      event(DOCS, 2, "2026-09-25T00:00:00Z"),
      event({ repo: "" }, 0, "2026-09-29T00:00:00Z"),
    ];
    const latest = latestEventsByScope(events);
    expect([...latest.keys()]).toEqual(["label:Documentation"]);
    expect(latest.get("label:Documentation")?.toLevel).toBe(0);
  });
});

describe("autonomyLevelFor", () => {
  it("is level 0 when work.toml sets no scope", () => {
    expect(autonomyLevelFor({}, { labels: ["Documentation"] }, []).level).toBe(0);
  });

  it("is level 0 when no scope matches", () => {
    const result = autonomyLevelFor(WORK, { labels: ["Bug"], repo: "aintel/web", paths: ["a.ts"] }, []);
    expect(result).toEqual({ level: 0, matches: [], undecided: [] });
  });

  it("takes the one matching scope's level", () => {
    expect(autonomyLevelFor(WORK, { labels: ["Documentation"] }, []).level).toBe(2);
  });

  it("takes the lowest level among the scopes a work item falls in", () => {
    const target = { labels: ["Documentation"], repo: "aintel/billing-service", paths: ["src/docs.ts"] };
    const result = autonomyLevelFor(WORK, target, []);
    expect(result.level).toBe(1);
    expect(result.matches.map((m) => m.level)).toEqual([2, 1]);
  });

  it("applies a lowering before the steering PR that writes it merges", () => {
    const events = [event(DOCS, 1, "2026-09-29T11:59:00Z")];
    expect(autonomyLevelFor(WORK, { labels: ["Documentation"] }, events).level).toBe(1);
  });

  it("is level 0 while a path scope in the repository cannot be decided", () => {
    const result = autonomyLevelFor(WORK, { labels: ["Documentation"], repo: "aintel/billing-service" }, []);
    expect(result.level).toBe(0);
    expect(result.undecided.map((e) => e.operator)).toEqual(["sam"]);
    expect(result.matches.map((m) => m.entry.operator)).toEqual(["priya"]);
  });
});
