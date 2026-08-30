/**
 * Unit tests for `oxagen init` — settings scaffolding + summary formatting.
 *
 * Narrow scope per CLAUDE.md: tests cover only the pure functions exposed by
 * init.ts (settings file creation/merge and summary rendering). Code-graph
 * building is covered by the daemon/code-graph builder tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSettingsFiles,
  formatInitSummary,
  runInit,
  type InitResult,
  type InitProgressEvent,
} from "../init.js";

// No AI credential in this hermetic unit test — domain inference must skip
// cleanly rather than making a real network call (the ambient dev shell may
// have a real AI_GATEWAY_API_KEY/ANTHROPIC_API_KEY exported). init.ts checks
// resolveAiCredential()/credentialSupportsModel(), not ensureGatewayKey()
// directly (see agent/env.ts).
vi.mock("../../agent/env.js", () => ({
  resolveAiCredential: () => null,
  credentialSupportsModel: () => false,
}));

// createCodeGraphStore() throws synchronously here, simulating the native
// duckdb module being unavailable (e.g. a bench/CI container that skipped
// OXAGEN_INSTALL_DUCKDB) — see the "resilience" describe block below.
vi.mock("../../daemon/code-graph/store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../daemon/code-graph/store.js")>();
  return {
    ...actual,
    createCodeGraphStore: () => {
      throw new Error("duckdb native module not installed");
    },
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "oxagen-init-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Build a minimal InitResult suitable for rendering tests
function makeResult(overrides: Partial<InitResult> = {}): InitResult {
  return {
    projectSettingsPath: join(tmpDir, ".oxagen", "settings.json"),
    projectSettingsCreated: true,
    userSettingsPath: join(tmpDir, "user-settings.json"),
    userSettingsCreated: true,
    graph: {
      files: 42,
      totalSymbols: 120,
      totalEdges: 87,
      symbolsByKind: { function: 60, class: 20, interface: 15, type: 25 },
      edgesByType: { contains: 55, calls: 20, imports: 12 },
      languages: ["typescript", "javascript"],
      indexed: 40,
      skipped: 2,
    },
    domains: [
      { name: "billing", files: 12 },
      { name: "auth", files: 8 },
      { name: "graph", files: 5 },
    ],
    domainsSkipped: false,
    workspaceLink: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Settings scaffolding
// ---------------------------------------------------------------------------

describe("ensureSettingsFiles", () => {
  it("creates both project and user settings files when they do not exist", () => {
    const userPath = join(tmpDir, "user-settings.json");
    const result = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(result.userCreated).toBe(true);
    expect(result.projectCreated).toBe(true);
    expect(existsSync(result.userPath)).toBe(true);
    expect(existsSync(result.projectPath)).toBe(true);
  });

  it("writes valid JSON to both files", () => {
    const userPath = join(tmpDir, "user-settings.json");
    ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });

    const projectRaw = readFileSync(
      join(tmpDir, ".oxagen", "settings.json"),
      "utf8",
    );
    const userRaw = readFileSync(userPath, "utf8");

    const project = JSON.parse(projectRaw) as Record<string, unknown>;
    const user = JSON.parse(userRaw) as Record<string, unknown>;

    // Both should have the starter $schema field
    expect(project["$schema"]).toContain("oxagen.sh");
    expect(user["$schema"]).toContain("oxagen.sh");
  });

  it("does not clobber existing project settings", () => {
    const userPath = join(tmpDir, "user-settings.json");
    // Pre-create the .oxagen dir + settings with custom content
    const oxagenDir = join(tmpDir, ".oxagen");
    mkdirSync(oxagenDir, { recursive: true });
    const projectPath = join(oxagenDir, "settings.json");
    const customContent = JSON.stringify({
      $schema: "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json",
      model: "my-custom-model",
      permissions: {
        allow: ["Bash(git*)"],
        deny: [],
      },
    });
    writeFileSync(projectPath, customContent, "utf8");

    const result = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(result.projectCreated).toBe(false);
    // Original content must be preserved
    const after = readFileSync(projectPath, "utf8");
    const parsed = JSON.parse(after) as Record<string, unknown>;
    expect(parsed["model"]).toBe("my-custom-model");
    const perms = parsed["permissions"] as Record<string, unknown>;
    expect(perms["allow"]).toContain("Bash(git*)");
  });

  it("does not clobber existing user settings", () => {
    const userPath = join(tmpDir, "user-settings.json");
    const customUserContent = JSON.stringify({
      $schema: "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json",
      model: "my-global-model",
    });
    writeFileSync(userPath, customUserContent, "utf8");

    const result = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(result.userCreated).toBe(false);
    const after = readFileSync(userPath, "utf8");
    const parsed = JSON.parse(after) as Record<string, unknown>;
    expect(parsed["model"]).toBe("my-global-model");
  });

  it("returns correct paths", () => {
    const userPath = join(tmpDir, "user-settings.json");
    const result = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(result.projectPath).toBe(join(tmpDir, ".oxagen", "settings.json"));
    expect(result.userPath).toBe(userPath);
  });

  it("is idempotent — second call reports created:false for both", () => {
    const userPath = join(tmpDir, "user-settings.json");
    ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });
    const second = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(second.projectCreated).toBe(false);
    expect(second.userCreated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatInitSummary
// ---------------------------------------------------------------------------

describe("formatInitSummary", () => {
  it("includes file, symbol, and edge counts", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("42 files");
    expect(summary).toContain("120 symbols");
    expect(summary).toContain("87 edges");
  });

  it("reports how many files were read (parsed vs unchanged)", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("Files read: 42");
    expect(summary).toContain("parsed 40");
    expect(summary).toContain("unchanged 2");
  });

  it("reports total node count (files + symbols)", () => {
    const summary = formatInitSummary(makeResult());
    // 42 files + 120 symbols = 162 nodes
    expect(summary).toContain("Nodes:");
    expect(summary).toContain("162");
  });

  it("lists all inferred domains", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("billing");
    expect(summary).toContain("auth");
    expect(summary).toContain("graph");
  });

  it("shows per-domain file counts", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("12");
    expect(summary).toContain("8");
    expect(summary).toContain("5");
  });

  it("shows graceful 'skipped' message when domainsSkipped=true", () => {
    const summary = formatInitSummary(
      makeResult({ domains: null, domainsSkipped: true }),
    );
    expect(summary).toContain("skipped");
    expect(summary).toContain("oxagen login");
  });

  it("shows 'none inferred' when domains empty + not skipped", () => {
    const summary = formatInitSummary(
      makeResult({ domains: [], domainsSkipped: false }),
    );
    expect(summary).toContain("none inferred");
  });

  it("shows 'Created' for newly created settings files", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("Created");
  });

  it("shows 'Found' for pre-existing settings files", () => {
    const summary = formatInitSummary(
      makeResult({ projectSettingsCreated: false, userSettingsCreated: false }),
    );
    expect(summary).toContain("Found");
  });

  it("lists detected languages", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("typescript");
    expect(summary).toContain("javascript");
  });

  it("includes symbol kinds", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("function:60");
    expect(summary).toContain("class:20");
  });

  it("includes edge types", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("contains:55");
    expect(summary).toContain("calls:20");
  });

  it("shows precedence note for settings tiers", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("global");
    expect(summary).toContain("project");
    expect(summary).toContain("local");
  });
});

// ---------------------------------------------------------------------------
// runInit — code-graph store resilience
// ---------------------------------------------------------------------------

describe("runInit", () => {
  it("falls back to an in-memory graph instead of crashing when createCodeGraphStore throws synchronously", async () => {
    // Regression test: createCodeGraphStore() used to be called OUTSIDE
    // runInit's try/catch. Its constructor does a bare require("duckdb"),
    // which throws synchronously when the native module isn't installed (the
    // default state in a bench/CI container without OXAGEN_INSTALL_DUCKDB) —
    // that exception was uncaught, crashing `oxagen init` instead of
    // degrading to the in-memory build the way the agent's own
    // loadOrBuildCodeGraph() already does.
    const userPath = join(tmpDir, "user-settings.json");

    // The core assertion IS that this resolves at all: createCodeGraphStore is
    // mocked to always throw, so the only way runInit() can return (rather
    // than reject) is via the in-memory fallback's catch block.
    const result = await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
    });

    // tmpDir has no source files, so the in-memory fallback (buildCodeGraph)
    // finds an empty graph — nothing persisted, so nothing "skipped" either.
    expect(result.graph.indexed).toBe(0);
    expect(result.graph.skipped).toBe(0);
    expect(result.domainsSkipped).toBe(true); // no AI credential mocked in
  });

  it("reports indexed as a FILE count in the in-memory fallback, not a node count", async () => {
    // Regression test: the fallback branch used to set `indexed =
    // graph.nodes.size`, which counts files AND symbols together. With an
    // empty tmpDir (the test above) files === symbols === 0, so that bug was
    // invisible — write real files so `indexed` (files) and node count
    // (files + symbols) actually diverge, and formatInitSummary's "Files
    // read: N (parsed M)" can never show M > N again.
    writeFileSync(
      join(tmpDir, "a.ts"),
      "export function foo() { return 1; }\nexport function bar() { return 2; }\n",
      "utf8",
    );
    writeFileSync(join(tmpDir, "b.ts"), 'import { foo } from "./a";\n', "utf8");
    const userPath = join(tmpDir, "user-settings.json");

    const result = await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
    });

    expect(result.graph.files).toBe(2);
    expect(result.graph.totalSymbols).toBe(2); // foo, bar
    expect(result.graph.indexed).toBe(2); // files parsed — NOT 4 (files + symbols)
    expect(result.graph.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runInit — onProgress (see tui/init-animation.tsx, the real consumer)
// ---------------------------------------------------------------------------

describe("runInit onProgress", () => {
  it("emits real phase-boundary events in order, with no AI credential and no link", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const events: InitProgressEvent[] = [];

    await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
      onProgress: (e) => {
        events.push(e);
      },
    });

    // tmpDir is empty, so no per-file "graph"/"progress" ticks fire (the
    // build loop never executes) — this hermetic run's phase sequence is
    // exactly settings -> graph -> domains, with no link boundary at all.
    expect(events.map((e) => `${e.phase}:${e.status}`)).toEqual([
      "settings:start",
      "settings:done",
      "graph:start",
      "graph:done",
      "domains:skipped",
    ]);
  });

  it("carries real stats on the graph:done event", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const events: InitProgressEvent[] = [];

    await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
      onProgress: (e) => {
        events.push(e);
      },
    });

    const graphDone = events.find(
      (
        e,
      ): e is Extract<InitProgressEvent, { phase: "graph"; status: "done" }> =>
        e.phase === "graph" && e.status === "done",
    );
    expect(graphDone?.stats.files).toBe(0); // empty tmpDir
    expect(graphDone?.stats.indexed).toBe(0);
  });

  it("never emits a link event when noLink is set", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const events: InitProgressEvent[] = [];

    await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
      onProgress: (e) => {
        events.push(e);
      },
    });

    expect(events.some((e) => e.phase === "link")).toBe(false);
  });

  it("awaits an async onProgress callback between phases", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const seen: string[] = [];

    await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
      onProgress: async (e) => {
        // A real await gap — if runInit forgot to await onProgress, phases
        // could interleave with this resolving late instead of in order.
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`${e.phase}:${e.status}`);
      },
    });

    expect(seen).toEqual([
      "settings:start",
      "settings:done",
      "graph:start",
      "graph:done",
      "domains:skipped",
    ]);
  });

  it("behaves identically when onProgress is omitted", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const result = await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
    });
    expect(result.domainsSkipped).toBe(true);
  });
});
