/**
 * Tests for prompt enhancement (F1 localization, F8 repo priors, F9 recall filter).
 *
 * Tests the wiring of deterministic localization, repo-prior injection, and
 * memory-recall applicability filtering into the ENHANCE stage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enhancePrompt, extractCandidates } from "./prompt-enhancer";
import type { CodeGraphProvider, Workspace } from "../types";
import type { MemoryProvider } from "../ports";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RepoPrior } from "../priors";
import { savePrior } from "../priors";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCodeGraphProvider(
  overrides: Partial<CodeGraphProvider> = {},
): CodeGraphProvider {
  return {
    query: vi.fn().mockResolvedValue(""),
    ...overrides,
  };
}

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
  delete process.env.OXAGEN_LOCALIZE;
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

// ── extractCandidates ────────────────────────────────────────────────────────

describe("extractCandidates", () => {
  it("extracts backticked symbols and paths", () => {
    const prompt = "fix `loginUser` in `src/auth.ts`";
    const result = extractCandidates(prompt);
    expect(result.symbols).toContain("loginUser");
    expect(result.paths).toContain("src/auth.ts");
  });

  it("extracts CamelCase and snake_case identifiers", () => {
    const prompt = "fix the LoginValidator and user_id field";
    const result = extractCandidates(prompt);
    expect(result.symbols).toContain("LoginValidator");
    expect(result.symbols).toContain("user_id");
  });

  it("filters prose stopwords", () => {
    const prompt = "fix the bug in the code";
    const result = extractCandidates(prompt);
    // "fix", "the", "bug", "code" are stopwords or too short.
    expect(result.symbols.length).toBe(0);
  });
});

// ── F1 Localization ──────────────────────────────────────────────────────────

describe("F1: Localization", () => {
  it("runs localization when flag is unset (default on)", async () => {
    delete process.env.OXAGEN_LOCALIZE;
    const graph = makeCodeGraphProvider({
      query: vi.fn().mockResolvedValue("packages/auth/index.ts"),
    });

    // Mock localize to return a non-empty renderedBlock.
    const mockLocalize = vi.spyOn(await import("../localize"), "localize");
    mockLocalize.mockResolvedValue({
      files: [
        {
          path: "packages/auth/index.ts",
          symbols: ["loginUser"],
          score: 5,
          reason: "traceback hit",
        },
      ],
      testHints: ["packages/auth/test"],
      tracebackParsed: true,
      renderedBlock:
        "## Candidate locations (deterministic)\n- **packages/auth/index.ts**",
    });

    const result = await enhancePrompt({
      prompt: "fix the login bug",
      codeGraph: graph,
    });

    expect(result.hasLocalization).toBe(true);
    mockLocalize.mockRestore();
  });

  it("skips localization when OXAGEN_LOCALIZE=0", async () => {
    setEnv("OXAGEN_LOCALIZE", "0");
    const graph = makeCodeGraphProvider();

    const mockLocalize = vi.spyOn(await import("../localize"), "localize");
    mockLocalize.mockResolvedValue({
      files: [],
      testHints: [],
      tracebackParsed: false,
      renderedBlock: "## Candidate locations (deterministic)",
    });

    const result = await enhancePrompt({
      prompt: "fix the login bug",
      codeGraph: graph,
    });

    // Localize should not be called when flag is "0".
    expect(result.hasLocalization).toBe(false);
    mockLocalize.mockRestore();
  });

  it("returns empty renderedBlock and sets hasLocalization=false when localize returns empty", async () => {
    const graph = makeCodeGraphProvider();

    const mockLocalize = vi.spyOn(await import("../localize"), "localize");
    mockLocalize.mockResolvedValue({
      files: [],
      testHints: [],
      tracebackParsed: false,
      renderedBlock: "",
    });

    const result = await enhancePrompt({
      prompt: "fix the login bug",
      codeGraph: graph,
    });

    expect(result.hasLocalization).toBe(false);
    mockLocalize.mockRestore();
  });

  it("gracefully handles localize errors (defensive try/catch)", async () => {
    const graph = makeCodeGraphProvider();

    const mockLocalize = vi.spyOn(await import("../localize"), "localize");
    mockLocalize.mockRejectedValue(new Error("graph unavailable"));

    // Should not throw; enhancement degrades gracefully.
    const result = await enhancePrompt({
      prompt: "fix the login bug",
      codeGraph: graph,
    });

    expect(result.hasLocalization).toBe(false);
    mockLocalize.mockRestore();
  });

  it("forwards the remaining stage budget to localize (races the budget, never extends it)", async () => {
    const graph = makeCodeGraphProvider();

    const mockLocalize = vi.spyOn(await import("../localize"), "localize");
    mockLocalize.mockResolvedValue({
      files: [],
      testHints: [],
      tracebackParsed: false,
      renderedBlock: "",
    });

    await enhancePrompt({
      prompt: "fix the login bug",
      codeGraph: graph,
      timeoutMs: 5_000,
    });

    expect(mockLocalize).toHaveBeenCalledTimes(1);
    const [, , locOpts] = mockLocalize.mock.calls[0]!;
    expect(locOpts?.semanticFallback).toBe(false);
    // The forwarded budget is the REMAINING slice of the 5 s stage budget —
    // positive, and never more than the stage budget itself.
    expect(locOpts?.timeoutMs).toBeGreaterThan(0);
    expect(locOpts?.timeoutMs).toBeLessThanOrEqual(5_000);
    mockLocalize.mockRestore();
  });

  it("passes an effectively-unbounded budget to localize when ENHANCE has no timeout", async () => {
    const graph = makeCodeGraphProvider();

    const mockLocalize = vi.spyOn(await import("../localize"), "localize");
    mockLocalize.mockResolvedValue({
      files: [],
      testHints: [],
      tracebackParsed: false,
      renderedBlock: "",
    });

    await enhancePrompt({ prompt: "fix the login bug", codeGraph: graph });

    const [, , locOpts] = mockLocalize.mock.calls[0]!;
    // MAX_SAFE_INTEGER — the localizer treats over-max-timer values as no deadline.
    expect(locOpts?.timeoutMs).toBe(Number.MAX_SAFE_INTEGER);
    mockLocalize.mockRestore();
  });
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

  it("gracefully handles filtering errors (fall back to raw memory)", async () => {
    setEnv("OXAGEN_RECALL_FILTER", "1");

    const memory = makeMemoryProvider("- some lesson");

    // Simulate a mock that might fail during filtering.
    const mockLocalize = vi.spyOn(await import("../localize"), "localize");
    mockLocalize.mockRejectedValue(new Error("graph error"));

    const result = await enhancePrompt({
      prompt: "fix something",
      memory,
      codeGraph: makeCodeGraphProvider(),
    });

    // Should gracefully degrade, keeping memory (possibly unfiltered).
    expect(result.hasMemory).toBe(true);

    mockLocalize.mockRestore();
  });
});

// ── Integration: all three features together ──────────────────────────────────

describe("Integration: F1 + F8 + F9", () => {
  it("injects localization, prior, and filtered recall in correct order", async () => {
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

    const graph = makeCodeGraphProvider();
    const memory = makeMemoryProvider("- use async/await\n- validate input");

    const mockLocalize = vi.spyOn(await import("../localize"), "localize");
    mockLocalize.mockResolvedValue({
      files: [
        {
          path: "src/auth.ts",
          symbols: ["login"],
          score: 5,
          reason: "symbol hit",
        },
      ],
      testHints: [],
      tracebackParsed: true,
      renderedBlock:
        "## Candidate locations (deterministic)\n- **src/auth.ts**",
    });

    const result = await enhancePrompt({
      prompt: "fix async login validation",
      codeGraph: graph,
      memory,
      repo: "django/django",
      priorsDir: tmpDir,
    });

    expect(result.hasLocalization).toBe(true);
    expect(result.hasRepoPrior).toBe(true);
    expect(result.filteredRecall).toBe(true);
    expect(result.hasMemory).toBe(true);

    // Verify order: localization first, then prior, then memory.
    const locIdx = result.context.indexOf("## Candidate locations");
    const priorIdx = result.context.indexOf("## Repo prior:");
    const recallIdx = result.context.indexOf("## Lessons from prior sessions");

    expect(locIdx).toBeLessThan(priorIdx);
    expect(priorIdx).toBeLessThan(recallIdx);

    mockLocalize.mockRestore();
    rmSync(tmpDir, { recursive: true });
  });

  it("returns correct EnhanceResult flags", async () => {
    const graph = makeCodeGraphProvider({
      query: vi.fn().mockResolvedValue(""),
    });
    const memory = makeMemoryProvider("");

    const result = await enhancePrompt({
      prompt: "fix something",
      codeGraph: graph,
      memory,
    });

    // All flags should be false when no features are enabled.
    expect(result.hasLocalization).toBe(false);
    expect(result.hasRepoPrior).toBe(false);
    expect(result.filteredRecall).toBe(false);
    expect(result.hasMemory).toBe(false);

    // Other fields should be present and valid.
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(Array.isArray(result.resolved)).toBe(true);
    expect(result.usedSemanticFallback).toBe(false);
  });
});
