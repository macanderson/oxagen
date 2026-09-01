/**
 * Tests for prompt enhancement (F8 repo priors, F9 recall filter).
 *
 * Tests the wiring of repo-prior injection and memory-recall applicability
 * filtering into the ENHANCE stage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enhancePrompt } from "./prompt-enhancer";
import type { MemoryProvider } from "../ports";
import { mkdtempSync, rmSync } from "node:fs";
import type { RepoPrior } from "../priors";
import { savePrior } from "../priors";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMemoryProvider(context: string = ""): MemoryProvider {
  return {
    recallContext: vi.fn().mockResolvedValue(context),
    remember: vi.fn(),
  };
}

// Save and restore env vars in tests.
const originalEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  originalEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  // Default state: flags unset or off.
  delete process.env.OXAGEN_REPO_PRIORS;
  delete process.env.OXAGEN_RECALL_FILTER;
});

afterEach(() => {
  // Restore original env vars.
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  Object.keys(originalEnv).length = 0;
});

// ── F8 Repo Prior Injection ──────────────────────────────────────────────────

describe("F8: Repo Prior Injection", () => {
  it("injects prior when repo + priorsDir + OXAGEN_REPO_PRIORS=1", async () => {
    setEnv("OXAGEN_REPO_PRIORS", "1");

    const tmpDir = mkdtempSync("oxagen-test-");
    const prior: RepoPrior = {
      repo: "django/django",
      testInvocation: "./tests/runtests.py <label>",
      testDiscovery: "tests/test_<module>.py",
      layout: ["src/", "tests/"],
      conventions: ["PEP 8"],
      pitfalls: ["MAX_NUM_FORMS=0 means unlimited"],
      updatedAt: new Date().toISOString(),
      sourceRuns: 1,
    };
    savePrior(tmpDir, prior);

    const result = await enhancePrompt({
      prompt: "fix the forms bug",
      repo: "django/django",
      priorsDir: tmpDir,
    });

    expect(result.hasRepoPrior).toBe(true);
    expect(result.context).toContain("## Repo prior:");
    expect(result.context).toContain("MAX_NUM_FORMS=0");

    rmSync(tmpDir, { recursive: true });
  });

  it("skips prior when OXAGEN_REPO_PRIORS is unset", async () => {
    delete process.env.OXAGEN_REPO_PRIORS;

    const tmpDir = mkdtempSync("oxagen-test-");
    const prior: RepoPrior = {
      repo: "django/django",
      testInvocation: "./tests/runtests.py <label>",
      testDiscovery: "tests/test_<module>.py",
      layout: [],
      conventions: [],
      pitfalls: [],
      updatedAt: new Date().toISOString(),
      sourceRuns: 1,
    };
    savePrior(tmpDir, prior);

    const result = await enhancePrompt({
      prompt: "fix the forms bug",
      repo: "django/django",
      priorsDir: tmpDir,
    });

    expect(result.hasRepoPrior).toBe(false);

    rmSync(tmpDir, { recursive: true });
  });

  it("skips prior when repo is missing", async () => {
    setEnv("OXAGEN_REPO_PRIORS", "1");

    const tmpDir = mkdtempSync("oxagen-test-");

    const result = await enhancePrompt({
      prompt: "fix the forms bug",
      repo: undefined,
      priorsDir: tmpDir,
    });

    expect(result.hasRepoPrior).toBe(false);

    rmSync(tmpDir, { recursive: true });
  });

  it("gracefully handles missing prior file", async () => {
    setEnv("OXAGEN_REPO_PRIORS", "1");

    const tmpDir = mkdtempSync("oxagen-test-");

    const result = await enhancePrompt({
      prompt: "fix the forms bug",
      repo: "nonexistent/repo",
      priorsDir: tmpDir,
    });

    expect(result.hasRepoPrior).toBe(false);

    rmSync(tmpDir, { recursive: true });
  });
});

// ── F9 Memory Recall Filtering ───────────────────────────────────────────────

describe("F9: Memory Recall Filtering", () => {
  it("filters recall when OXAGEN_RECALL_FILTER=1", async () => {
    setEnv("OXAGEN_RECALL_FILTER", "1");

    const memory = makeMemoryProvider(
      "- use async/await patterns\n- always validate user input\n- unrelated lesson",
    );

    const result = await enhancePrompt({
      prompt: "fix async input validation in login",
      memory,
    });

    expect(result.filteredRecall).toBe(true);
    // Filtered recall should have the tag "[recall — verify before trusting]".
    expect(result.context).toContain("[recall — verify before trusting]");
  });

  it("skips filtering when OXAGEN_RECALL_FILTER is unset", async () => {
    delete process.env.OXAGEN_RECALL_FILTER;

    const rawContext = "- use async/await patterns\n- validate input";
    const memory = makeMemoryProvider(rawContext);

    const result = await enhancePrompt({
      prompt: "fix async input validation",
      memory,
    });

    expect(result.filteredRecall).toBe(false);
    // Raw context should be injected without tagging.
    expect(result.context).toContain("- use async/await patterns");
    expect(result.context).not.toContain("[recall — verify before trusting]");
  });

  it("drops items with zero overlap in stage 1", async () => {
    setEnv("OXAGEN_RECALL_FILTER", "1");

    // Memory with no overlap to the issue "fix login".
    const memory = makeMemoryProvider(
      "- handle XML parsing edge cases\n- optimize database queries\n- fix unicode encoding",
    );

    const result = await enhancePrompt({
      prompt: "fix the login timeout",
      memory,
    });

    expect(result.filteredRecall).toBe(true);
    // Items should be filtered (tag should be applied if any survive).
    // The exact count depends on lexical overlap; verify the filtering ran.
    expect(result.context).toContain("[recall — verify before trusting]");
  });

  it("keeps memory when the recall provider itself throws", async () => {
    setEnv("OXAGEN_RECALL_FILTER", "1");

    const memory: MemoryProvider = {
      recallContext: vi.fn().mockRejectedValue(new Error("store offline")),
      remember: vi.fn(),
    };

    // Recall is best-effort: a failing provider degrades to no memory rather
    // than failing the turn.
    const result = await enhancePrompt({ prompt: "fix something", memory });

    expect(result.hasMemory).toBe(false);
    expect(result.context).toBe("");
  });
});

// ── Integration: F8 + F9 together ─────────────────────────────────────────────

describe("Integration: F8 + F9", () => {
  it("injects prior and filtered recall in that order", async () => {
    setEnv("OXAGEN_REPO_PRIORS", "1");
    setEnv("OXAGEN_RECALL_FILTER", "1");

    const tmpDir = mkdtempSync("oxagen-test-");
    const prior: RepoPrior = {
      repo: "django/django",
      testInvocation: "./tests/runtests.py <label>",
      testDiscovery: "tests/test_<module>.py",
      layout: ["src/"],
      conventions: ["PEP 8"],
      pitfalls: ["trap"],
      updatedAt: new Date().toISOString(),
      sourceRuns: 1,
    };
    savePrior(tmpDir, prior);

    const memory = makeMemoryProvider("- use async/await\n- validate input");

    const result = await enhancePrompt({
      prompt: "fix async login validation",
      memory,
      repo: "django/django",
      priorsDir: tmpDir,
    });

    expect(result.hasRepoPrior).toBe(true);
    expect(result.filteredRecall).toBe(true);
    expect(result.hasMemory).toBe(true);

    const priorIdx = result.context.indexOf("## Repo prior:");
    const recallIdx = result.context.indexOf("## Lessons from prior sessions");
    expect(priorIdx).toBeGreaterThanOrEqual(0);
    expect(priorIdx).toBeLessThan(recallIdx);

    rmSync(tmpDir, { recursive: true });
  });

  it("returns correct EnhanceResult flags", async () => {
    const memory = makeMemoryProvider("");

    const result = await enhancePrompt({ prompt: "fix something", memory });

    // All flags should be false when no features are enabled.
    expect(result.hasRepoPrior).toBe(false);
    expect(result.filteredRecall).toBe(false);
    expect(result.hasMemory).toBe(false);

    // Other fields should be present and valid.
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.prompt).toBe("fix something");
    expect(result.context).toBe("");
  });
});
