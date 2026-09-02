/**
 * Tests for the per-repo procedural priors store and render (F8).
 *
 * Coverage: load/save round-trip, slug mapping, missing/corrupt file handling,
 * atomic writes, renderPrior 2000-char cap with truncation order, accruePitfalls
 * dedup and cap, lintPriorLegality issue/PR/diff detection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPrior,
  savePrior,
  renderPrior,
  accruePitfalls,
  lintPriorLegality,
  type RepoPrior,
} from "./index";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "oxagen-priors-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function createPrior(overrides?: Partial<RepoPrior>): RepoPrior {
  return {
    repo: "django/django",
    testInvocation: "./tests/runtests.py --label=<label>",
    testDiscovery: "tests/test_<module>.py",
    layout: ["src/", "tests/", "docs/"],
    conventions: ["Use pytest markers", "Models in models.py"],
    pitfalls: ["MAX_FORMS=0 is unlimited", "Timezone handling"],
    updatedAt: "2024-01-01T00:00:00Z",
    sourceRuns: 1,
    ...overrides,
  };
}

// ── Load/Save round-trip ───────────────────────────────────────────────────

describe("loadPrior and savePrior", () => {
  it("saves and loads a prior round-trip", () => {
    const prior = createPrior();
    savePrior(baseDir, prior);
    const loaded = loadPrior(baseDir, prior.repo);
    expect(loaded).toEqual(prior);
  });

  it("creates baseDir if needed", () => {
    const newDir = join(baseDir, "nested", "path");
    const prior = createPrior();
    savePrior(newDir, prior);
    expect(existsSync(newDir)).toBe(true);
    const loaded = loadPrior(newDir, prior.repo);
    expect(loaded).toEqual(prior);
  });

  it("handles pretty-printed JSON (multiple saves/loads)", () => {
    const prior = createPrior();
    savePrior(baseDir, prior);
    // Verify JSON is pretty-printed.
    const filePath = join(baseDir, "django__django.json");
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("\n");
    expect(content).toContain("  ");

    // Load again.
    const loaded = loadPrior(baseDir, prior.repo);
    expect(loaded).toEqual(prior);
  });
});

// ── Slug mapping ───────────────────────────────────────────────────────────

describe("slug mapping (repo → filename)", () => {
  it("maps django/django to django__django.json", () => {
    const prior = createPrior({ repo: "django/django" });
    savePrior(baseDir, prior);
    expect(existsSync(join(baseDir, "django__django.json"))).toBe(true);
  });

  it("maps sympy/sympy to sympy__sympy.json", () => {
    const prior = createPrior({ repo: "sympy/sympy" });
    savePrior(baseDir, prior);
    expect(existsSync(join(baseDir, "sympy__sympy.json"))).toBe(true);
  });

  it("handles repos with multiple slashes (replaces all)", () => {
    const prior = createPrior({ repo: "org/sub/repo" });
    savePrior(baseDir, prior);
    expect(existsSync(join(baseDir, "org__sub__repo.json"))).toBe(true);
  });

  it("loads using the same slug mapping", () => {
    const prior = createPrior({ repo: "test/repo" });
    savePrior(baseDir, prior);
    const loaded = loadPrior(baseDir, "test/repo");
    expect(loaded?.repo).toBe("test/repo");
  });
});

// ── Missing file ───────────────────────────────────────────────────────────

describe("loadPrior — missing file", () => {
  it("returns null when file does not exist", () => {
    const loaded = loadPrior(baseDir, "nonexistent/repo");
    expect(loaded).toBeNull();
  });

  it("returns null when directory does not exist", () => {
    const nonexistentDir = join(baseDir, "does", "not", "exist");
    const loaded = loadPrior(nonexistentDir, "any/repo");
    expect(loaded).toBeNull();
  });
});

// ── Corrupt JSON ───────────────────────────────────────────────────────────

describe("loadPrior — corrupt JSON", () => {
  it("returns null when JSON is invalid", () => {
    const filePath = join(baseDir, "django__django.json");
    writeFileSync(filePath, "not valid json", "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded).toBeNull();
  });

  it("returns null when JSON is not an object", () => {
    const filePath = join(baseDir, "django__django.json");
    writeFileSync(filePath, '["array"]', "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded).toBeNull();
  });

  it("returns null when repo field is missing", () => {
    const filePath = join(baseDir, "django__django.json");
    const data = createPrior();
    const { repo: _, ...rest } = data;
    writeFileSync(filePath, JSON.stringify(rest), "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded).toBeNull();
  });

  it("returns null when repo field does not match requested repo", () => {
    const filePath = join(baseDir, "django__django.json");
    const data = createPrior({ repo: "other/repo" });
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded).toBeNull();
  });

  it("returns null when layout is not an array", () => {
    const filePath = join(baseDir, "django__django.json");
    const data = createPrior({ layout: "not an array" as unknown as string[] });
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded).toBeNull();
  });

  it("returns null when layout contains non-strings", () => {
    const filePath = join(baseDir, "django__django.json");
    const data = createPrior({ layout: ["valid", 123 as unknown as string] });
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded).toBeNull();
  });

  it("returns null when sourceRuns is not an integer", () => {
    const filePath = join(baseDir, "django__django.json");
    const data = createPrior({ sourceRuns: 1.5 });
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded).toBeNull();
  });
});

// ── Truncation on load ─────────────────────────────────────────────────────

describe("loadPrior — array truncation", () => {
  it("truncates layout to 5 items on load", () => {
    const filePath = join(baseDir, "django__django.json");
    const data = createPrior({ layout: ["a", "b", "c", "d", "e", "f", "g"] });
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded?.layout).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("truncates conventions to 5 items on load", () => {
    const filePath = join(baseDir, "django__django.json");
    const data = createPrior({ conventions: ["a", "b", "c", "d", "e", "f"] });
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded?.conventions).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("truncates pitfalls to 10 items on load", () => {
    const filePath = join(baseDir, "django__django.json");
    const data = createPrior({
      pitfalls: Array.from({ length: 15 }, (_, i) => `pitfall${i}`),
    });
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    const loaded = loadPrior(baseDir, "django/django");
    expect(loaded?.pitfalls).toHaveLength(10);
  });
});

// ── Atomic writes ──────────────────────────────────────────────────────────

describe("savePrior — atomic writes", () => {
  it("does not leave a .tmp file after successful save", () => {
    const prior = createPrior();
    savePrior(baseDir, prior);
    const tmpPath = join(baseDir, "django__django.json.tmp");
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("uses rename (atomic on POSIX) to move .tmp to final", () => {
    const prior = createPrior();
    savePrior(baseDir, prior);
    const filePath = join(baseDir, "django__django.json");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf8");
    expect(JSON.parse(content)).toEqual(prior);
  });
});

// ── Render ─────────────────────────────────────────────────────────────────

describe("renderPrior", () => {
  it("renders with header and all sections", () => {
    const prior = createPrior();
    const rendered = renderPrior(prior);
    expect(rendered).toContain("## Repo prior: django/django");
    expect(rendered).toContain("**Test invocation:**");
    expect(rendered).toContain("**Test discovery:**");
    expect(rendered).toContain("**Layout:**");
    expect(rendered).toContain("**Conventions:**");
    expect(rendered).toContain("**Pitfalls:**");
  });

  it("includes all layout items as bullets", () => {
    const prior = createPrior({ layout: ["src/", "tests/", "docs/"] });
    const rendered = renderPrior(prior);
    expect(rendered).toContain("- src/");
    expect(rendered).toContain("- tests/");
    expect(rendered).toContain("- docs/");
  });

  it("includes all pitfalls as bullets", () => {
    const prior = createPrior({
      pitfalls: ["Trap 1", "Trap 2", "Trap 3"],
    });
    const rendered = renderPrior(prior);
    expect(rendered).toContain("- Trap 1");
    expect(rendered).toContain("- Trap 2");
    expect(rendered).toContain("- Trap 3");
  });

  it("respects 2000-char hard cap", () => {
    const prior = createPrior({
      layout: Array.from({ length: 5 }, (_, i) => `x`.repeat(100) + i),
      conventions: Array.from({ length: 5 }, (_, i) => `y`.repeat(100) + i),
      pitfalls: Array.from({ length: 10 }, (_, i) => `z`.repeat(100) + i),
    });
    const rendered = renderPrior(prior);
    expect(rendered.length).toBeLessThanOrEqual(2000);
  });

  it("never truncates testInvocation", () => {
    const longInvocation = "a".repeat(500);
    const prior = createPrior({
      testInvocation: longInvocation,
      layout: Array.from({ length: 5 }, (_, i) => `x`.repeat(200) + i),
      conventions: Array.from({ length: 5 }, (_, i) => `y`.repeat(200) + i),
      pitfalls: Array.from({ length: 10 }, (_, i) => `z`.repeat(200) + i),
    });
    const rendered = renderPrior(prior);
    expect(rendered).toContain(longInvocation);
    expect(rendered.length).toBeLessThanOrEqual(2000);
  });

  it("truncates pitfalls first when over 2000 chars", () => {
    const prior = createPrior({
      layout: Array.from({ length: 5 }, (_, i) => `layout${i}`.repeat(50)),
      conventions: Array.from({ length: 5 }, (_, i) => `conv${i}`.repeat(50)),
      pitfalls: Array.from({ length: 10 }, (_, i) => `pitfall${i}`.repeat(50)),
    });
    const rendered = renderPrior(prior);
    expect(rendered.length).toBeLessThanOrEqual(2000);
    // Should still have header, invocation, discovery, layout, conventions.
    expect(rendered).toContain("## Repo prior:");
    expect(rendered).toContain("**Test invocation:**");
    expect(rendered).toContain("**Test discovery:**");
    expect(rendered).toContain("**Layout:**");
    expect(rendered).toContain("**Conventions:**");
  });

  it("truncates conventions if still over after removing pitfalls", () => {
    const prior = createPrior({
      layout: Array.from({ length: 5 }, (_, i) => `layout${i}`.repeat(100)),
      conventions: Array.from({ length: 5 }, (_, i) => `conv${i}`.repeat(100)),
      pitfalls: Array.from({ length: 10 }, (_, i) => `pitfall${i}`.repeat(100)),
    });
    const rendered = renderPrior(prior);
    expect(rendered.length).toBeLessThanOrEqual(2000);
    // Should still have header, invocation, discovery, layout.
    expect(rendered).toContain("## Repo prior:");
    expect(rendered).toContain("**Layout:**");
  });

  it("truncates layout if still over after removing conventions", () => {
    const prior = createPrior({
      layout: Array.from({ length: 5 }, (_, i) => `layout${i}`.repeat(150)),
      conventions: Array.from({ length: 5 }, (_, i) => `conv${i}`.repeat(150)),
      pitfalls: Array.from({ length: 10 }, (_, i) => `pitfall${i}`.repeat(150)),
    });
    const rendered = renderPrior(prior);
    expect(rendered.length).toBeLessThanOrEqual(2000);
    // Should still have header, invocation, discovery.
    expect(rendered).toContain("## Repo prior:");
    expect(rendered).toContain("**Test invocation:**");
  });
});

// ── Accrue pitfalls ────────────────────────────────────────────────────────

describe("accruePitfalls", () => {
  it("returns null when prior does not exist", () => {
    const result = accruePitfalls(baseDir, "nonexistent/repo", ["lesson"]);
    expect(result).toBeNull();
  });

  it("appends new pitfalls to existing ones", () => {
    const prior = createPrior({ pitfalls: ["Old 1", "Old 2"] });
    savePrior(baseDir, prior);
    const result = accruePitfalls(baseDir, "django/django", ["New 1", "New 2"]);
    expect(result?.pitfalls).toEqual(["Old 1", "Old 2", "New 1", "New 2"]);
  });

  it("deduplicates lessons case-insensitively", () => {
    const prior = createPrior({ pitfalls: ["Lesson A"] });
    savePrior(baseDir, prior);
    const result = accruePitfalls(baseDir, "django/django", [
      "lesson a",
      "Lesson A",
      "LESSON A",
    ]);
    expect(result?.pitfalls).toEqual(["Lesson A"]);
  });

  it("deduplicates after whitespace collapse", () => {
    const prior = createPrior({ pitfalls: ["lesson one"] });
    savePrior(baseDir, prior);
    const result = accruePitfalls(baseDir, "django/django", [
      "  lesson   one  ",
    ]);
    expect(result?.pitfalls).toEqual(["lesson one"]);
  });

  it("caps pitfalls at 10, keeping oldest first", () => {
    const prior = createPrior({
      pitfalls: Array.from({ length: 8 }, (_, i) => `Old ${i}`),
    });
    savePrior(baseDir, prior);
    const result = accruePitfalls(baseDir, "django/django", [
      "New 1",
      "New 2",
      "New 3",
      "New 4",
    ]);
    expect(result?.pitfalls).toHaveLength(10);
    expect(result?.pitfalls[0]).toBe("Old 0");
    expect(result?.pitfalls[7]).toBe("Old 7");
    expect(result?.pitfalls[8]).toBe("New 1");
    expect(result?.pitfalls[9]).toBe("New 2");
  });

  it("increments sourceRuns by 1", () => {
    const prior = createPrior({ sourceRuns: 5 });
    savePrior(baseDir, prior);
    const result = accruePitfalls(baseDir, "django/django", ["lesson"]);
    expect(result?.sourceRuns).toBe(6);
  });

  it("updates updatedAt to current timestamp", () => {
    const prior = createPrior({ updatedAt: "2020-01-01T00:00:00Z" });
    savePrior(baseDir, prior);
    const before = new Date();
    const result = accruePitfalls(baseDir, "django/django", ["lesson"]);
    const after = new Date();
    expect(result?.updatedAt).toBeDefined();
    const timestamp = new Date(result!.updatedAt);
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("persists changes to disk", () => {
    const prior = createPrior({ pitfalls: ["Old"] });
    savePrior(baseDir, prior);
    accruePitfalls(baseDir, "django/django", ["New"]);
    const reloaded = loadPrior(baseDir, "django/django");
    expect(reloaded?.pitfalls).toEqual(["Old", "New"]);
  });

  it("handles empty lessons array", () => {
    const prior = createPrior({ pitfalls: ["Old"] });
    savePrior(baseDir, prior);
    const result = accruePitfalls(baseDir, "django/django", []);
    expect(result?.pitfalls).toEqual(["Old"]);
    expect(result?.sourceRuns).toBe(2);
  });
});

// ── Legality lint ──────────────────────────────────────────────────────────

describe("lintPriorLegality", () => {
  it("returns empty array for a legal prior", () => {
    const prior = createPrior();
    const violations = lintPriorLegality(prior);
    expect(violations).toEqual([]);
  });

  it("detects issue reference pattern #<digits>", () => {
    const prior = createPrior({ pitfalls: ["Fix for #12345"] });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("pitfalls[0]");
  });

  it("detects 'issue <digits>' pattern", () => {
    const prior = createPrior({ conventions: ["See issue 987"] });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("conventions[0]");
  });

  it("detects 'fixes <digits>' pattern", () => {
    const prior = createPrior({ testInvocation: "fixes 456" });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects GitHub issues URL", () => {
    const prior = createPrior({
      layout: ["https://github.com/django/django/issues/12345"],
    });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects GitHub pull URL", () => {
    const prior = createPrior({
      conventions: ["https://github.com/sympy/sympy/pull/98765"],
    });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects diff header 'diff --git'", () => {
    const prior = createPrior({
      pitfalls: ["diff --git a/file.py b/file.py"],
    });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects diff +++ line", () => {
    const prior = createPrior({
      layout: ["+++ b/file.py"],
    });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects diff --- line", () => {
    const prior = createPrior({
      conventions: ["--- a/file.py"],
    });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("detects diff hunk marker @@", () => {
    const prior = createPrior({
      pitfalls: ["@@ -1,3 +1,3 @@"],
    });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("passes a clean prior with procedural content", () => {
    const prior = createPrior({
      testInvocation: "./runtests.py --label=<label>",
      testDiscovery: "tests/test_<module>.py",
      layout: [
        "src/ — main source",
        "tests/ — test suite",
        "docs/ — documentation",
      ],
      conventions: [
        "Use pytest markers for test selection",
        "Models defined in models.py",
        "Views in views.py",
        "Middleware in middleware.py",
      ],
      pitfalls: [
        "MAX_FORMS=0 means unlimited, not zero",
        "Timezone-aware datetimes required",
        "QuerySet evaluation is lazy",
        "Signal handlers run synchronously",
        "Transaction rollback on exception",
      ],
    });
    const violations = lintPriorLegality(prior);
    expect(violations).toEqual([]);
  });

  it("detects multiple violations in one prior", () => {
    const prior = createPrior({
      pitfalls: ["See #123", "fixes issue 456"],
      conventions: ["diff --git a/file.py"],
    });
    const violations = lintPriorLegality(prior);
    expect(violations.length).toBeGreaterThan(2);
  });
});
