/**
 * `oxagen memory …` / `oxagen remember` handlers — pins the wire contract of
 * every subcommand through the apiPostOrThrow seam (exact route + body,
 * including the client-side defaults: list limit 100, show's 200-item lookup
 * page, stats days 30 / limit 10, candidates limit 3, dismiss restore false),
 * the argument validation that rejects before any request leaves the process,
 * show's list-then-resolve lookup (full id, publicId, short-id prefix),
 * import's read → parse_markdown_import → preview or commit_markdown_import
 * phases with per-file failure collection, the human/JSON output written through the CommandWriter, and the
 * one-shot path's stderr + exit(1) contract.
 */
import { describe, expect, it, vi } from "vitest";

const { apiPostOrThrow, readFile, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
    apiPostOrThrow: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
    readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
    MockApiError,
  };
});

vi.mock("../lib/api.js", () => ({ apiPostOrThrow, ApiError: MockApiError }));
vi.mock("node:fs/promises", () => ({ readFile }));

import { captureWriter } from "../lib/capture-writer";
import type { MemoryRecord } from "../lib/memory-client";
import {
  handleMemoryList,
  handleMemoryShow,
  handleMemoryEdit,
  handleMemorySalience,
  handleMemoryPromote,
  handleMemoryDemote,
  handleMemoryDismiss,
  handleMemoryCitations,
  handleMemoryCandidates,
  handleMemoryRemove,
  handleMemoryImport,
  handleRemember,
} from "./memory";

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_0123456789abcdef",
    publicId: "M-1",
    nodeRef: "app:web",
    memoryClass: "RULE",
    memoryKind: "gotcha",
    lesson: "Never run vitest in watch mode on CI",
    source: "user",
    confidenceScore: 82.4,
    enforcementScore: 70,
    status: "ACTIVE",
    subjectHint: "",
    halfLifeDays: 90,
    decayFloor: 20,
    lastEvidenceAt: null,
    citationCount: 3,
    influenceCount: 2,
    violationCount: 0,
    createdByKind: "USER",
    createdById: null,
    confirmedByKind: null,
    confirmedById: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    lastReinforcedAt: null,
    ...over,
  };
}

describe("memory list", () => {
  it("maps every CLI filter onto the list body — class upper-cased, ints parsed, citations sort renamed", async () => {
    apiPostOrThrow.mockResolvedValue({ memories: [record()], total: 1 });
    const captured = captureWriter();
    await handleMemoryList(
      {
        class: "rule",
        kind: "gotcha",
        minEnforcement: "50",
        minCitations: "2",
        sort: "citations",
        node: "app:web",
        limit: "10",
        offset: "5",
      },
      captured.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/list", {
      memoryClass: "RULE",
      memoryKind: "gotcha",
      minEnforcement: 50,
      minCitations: 2,
      sort: "citationCount",
      nodeRef: "app:web",
      limit: 10,
      offset: 5,
    });
    const lines = captured.output().split("\n");
    expect(lines[0]).toMatch(/^id\s+class\/kind\s+conf\s+enf\s+lesson$/);
    expect(lines[1]).toContain("mem_0123");
    expect(lines[1]).toContain("RULE/gotcha");
    expect(lines[1]).toContain("82.4");
    expect(lines[1]).toContain("Never run vitest in watch mode on CI");
    expect(lines[2]).toBe("1 memory.");
  });

  it("defaults to limit 100 / offset 0 and prints the empty-state hint when there are no memories", async () => {
    apiPostOrThrow.mockResolvedValue({ memories: [], total: 0 });
    const captured = captureWriter();
    await handleMemoryList({}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/list", {
      limit: 100,
      offset: 0,
    });
    expect(captured.output()).toBe(
      'No memories yet. Capture one with `/remember <text>` (or `oxagen remember "…"`).',
    );
  });

  it("passes a createdAt sort through unrenamed", async () => {
    apiPostOrThrow.mockResolvedValue({ memories: [], total: 0 });
    const captured = captureWriter();
    await handleMemoryList({ sort: "createdAt" }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/list", {
      sort: "createdAt",
      limit: 100,
      offset: 0,
    });
  });

  it("--json emits the raw list result and skips the table", async () => {
    const result = { memories: [record()], total: 1 };
    apiPostOrThrow.mockResolvedValue(result);
    const captured = captureWriter();
    await handleMemoryList({ json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual(result);
  });

  it("rejects an unknown --class before any request is made", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryList({ class: "bogus" }, captured.writer),
    ).rejects.toThrow(
      'Invalid class "bogus". Use one of: OBSERVATION, RULE, FACT.',
    );
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(captured.output()).toContain('Invalid class "bogus"');
  });

  it("rejects a non-integer --min-enforcement", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryList({ minEnforcement: "abc" }, captured.writer),
    ).rejects.toThrow('Invalid --min-enforcement "abc". Use an integer.');
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("rejects an unknown --sort", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryList({ sort: "zap" }, captured.writer),
    ).rejects.toThrow('Invalid --sort "zap". Use "createdAt" or "citations".');
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("surfaces an ApiError's message through the writer and rethrows", async () => {
    apiPostOrThrow.mockRejectedValue(
      new MockApiError("Error 401 from agent/memory/list: unauthorized", 401),
    );
    const captured = captureWriter();
    await expect(handleMemoryList({}, captured.writer)).rejects.toThrow(
      "Error 401 from agent/memory/list: unauthorized",
    );
    expect(captured.output()).toContain(
      "Error 401 from agent/memory/list: unauthorized",
    );
  });

  it("stringifies a non-Error rejection", async () => {
    apiPostOrThrow.mockRejectedValue("socket hangup");
    const captured = captureWriter();
    await expect(handleMemoryList({}, captured.writer)).rejects.toThrow(
      "socket hangup",
    );
  });
});

describe("memory show", () => {
  it("fetches one 200-item page and resolves by exact id, printing the detail block", async () => {
    apiPostOrThrow.mockResolvedValue({
      memories: [
        record({ id: "mem_other0000000000", publicId: "M-2" }),
        record(),
      ],
      total: 2,
    });
    const captured = captureWriter();
    await handleMemoryShow("mem_0123456789abcdef", {}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/list", {
      limit: 200,
      offset: 0,
    });
    const out = captured.output();
    expect(out).toContain("Memory mem_0123456789abcdef");
    expect(out).toContain(
      "  lesson:      Never run vitest in watch mode on CI",
    );
    expect(out).toContain("  enforcement: 70");
    expect(out).toContain("  nodeRef:     app:web");
  });

  it("resolves by publicId, and by short-id prefix when no exact match exists", async () => {
    apiPostOrThrow.mockResolvedValue({
      memories: [
        record({ id: "mem_other0000000000", publicId: "M-2" }),
        record(),
      ],
      total: 2,
    });
    const byPublicId = captureWriter();
    await handleMemoryShow("M-2", {}, byPublicId.writer);
    expect(byPublicId.output()).toContain("Memory mem_other0000000000");

    const byPrefix = captureWriter();
    await handleMemoryShow("mem_01", {}, byPrefix.writer);
    expect(byPrefix.output()).toContain("Memory mem_0123456789abcdef");
  });

  it("--json emits the matched record", async () => {
    const m = record();
    apiPostOrThrow.mockResolvedValue({ memories: [m], total: 1 });
    const captured = captureWriter();
    await handleMemoryShow("M-1", { json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual(m);
  });

  it("fails when nothing in the page matches", async () => {
    apiPostOrThrow.mockResolvedValue({ memories: [record()], total: 1 });
    const captured = captureWriter();
    await expect(handleMemoryShow("nope", {}, captured.writer)).rejects.toThrow(
      'No memory matching "nope" in this workspace (searched the latest 200).',
    );
  });
});

describe("memory edit", () => {
  it("refuses an empty edit without calling the API", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryEdit("mem_x", {}, captured.writer),
    ).rejects.toThrow(
      "Nothing to edit. Pass at least one of --lesson, --kind, or --source.",
    );
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("sends the changed fields and echoes the updated detail", async () => {
    apiPostOrThrow.mockResolvedValue(record({ lesson: "L2" }));
    const captured = captureWriter();
    await handleMemoryEdit(
      "mem_x",
      { lesson: "L2", kind: "style", source: "audit" },
      captured.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/update", {
      memoryId: "mem_x",
      lesson: "L2",
      memoryKind: "style",
      source: "audit",
    });
    const lines = captured.output().split("\n");
    expect(lines[0]).toBe("✓ Updated memory mem_0123456789abcdef.");
    expect(captured.output()).toContain("  lesson:      L2");
  });

  it("--json emits the updated record", async () => {
    const updated = record({ lesson: "L2" });
    apiPostOrThrow.mockResolvedValue(updated);
    const captured = captureWriter();
    await handleMemoryEdit(
      "mem_x",
      { lesson: "L2", json: true },
      captured.writer,
    );
    expect(JSON.parse(captured.output())).toEqual(updated);
  });
});

describe("memory salience", () => {
  it("refuses when no flag is given", async () => {
    const captured = captureWriter();
    await expect(
      handleMemorySalience("mem_x", {}, captured.writer),
    ).rejects.toThrow(
      "Nothing to update. Pass at least one of --confidence, --enforcement, or --status.",
    );
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range --confidence", async () => {
    const captured = captureWriter();
    await expect(
      handleMemorySalience("mem_x", { confidence: "150" }, captured.writer),
    ).rejects.toThrow(
      'Invalid --confidence "150". Use a number between 0 and 100.',
    );
  });

  it("rejects a non-integer --enforcement", async () => {
    const captured = captureWriter();
    await expect(
      handleMemorySalience("mem_x", { enforcement: "7.5" }, captured.writer),
    ).rejects.toThrow(
      'Invalid --enforcement "7.5". Use an integer between 1 and 100.',
    );
  });

  it("rejects an unknown --status", async () => {
    const captured = captureWriter();
    await expect(
      handleMemorySalience("mem_x", { status: "weird" }, captured.writer),
    ).rejects.toThrow(
      'Invalid status "weird". Use one of: ACTIVE, SUPERSEDED, RETRACTED, ARCHIVED.',
    );
  });

  it("sends parsed scores plus the upper-cased status and reports the new salience", async () => {
    apiPostOrThrow.mockResolvedValue(record());
    const captured = captureWriter();
    await handleMemorySalience(
      "mem_x",
      { confidence: "55.5", enforcement: "60", status: "active" },
      captured.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/update", {
      memoryId: "mem_x",
      confidenceScore: 55.5,
      enforcementScore: 60,
      status: "ACTIVE",
    });
    expect(captured.output()).toBe(
      "✓ Salience updated — class RULE, confidence 82.4, enforcement 70 (mem_0123456789abcdef).",
    );
  });

  it("renders a null enforcement as — on a status-only update", async () => {
    apiPostOrThrow.mockResolvedValue(
      record({ memoryClass: "OBSERVATION", enforcementScore: null }),
    );
    const captured = captureWriter();
    await handleMemorySalience(
      "mem_x",
      { status: "archived" },
      captured.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/update", {
      memoryId: "mem_x",
      status: "ARCHIVED",
    });
    expect(captured.output()).toContain("enforcement —");
  });

  it("--json emits the updated record", async () => {
    const updated = record();
    apiPostOrThrow.mockResolvedValue(updated);
    const captured = captureWriter();
    await handleMemorySalience(
      "mem_x",
      { confidence: "50", json: true },
      captured.writer,
    );
    expect(JSON.parse(captured.output())).toEqual(updated);
  });
});

describe("memory promote", () => {
  it("requires --to", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryPromote("mem_x", {}, captured.writer),
    ).rejects.toThrow("Missing --to. Use `--to rule` or `--to fact`.");
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("rejects a --to outside rule|fact", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryPromote("mem_x", { to: "observation" }, captured.writer),
    ).rejects.toThrow('Invalid --to "observation". Use "rule" or "fact".');
  });

  it("rejects an out-of-range --enforcement", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryPromote(
        "mem_x",
        { to: "rule", enforcement: "0" },
        captured.writer,
      ),
    ).rejects.toThrow(
      'Invalid --enforcement "0". Use an integer between 1 and 100.',
    );
  });

  it("promotes with enforcement and rationale and prints the promote summary", async () => {
    apiPostOrThrow.mockResolvedValue(
      record({ memoryClass: "FACT", enforcementScore: 100 }),
    );
    const captured = captureWriter();
    await handleMemoryPromote(
      "mem_x",
      { to: "fact", enforcement: "90", rationale: "well cited" },
      captured.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/promote", {
      memoryId: "mem_x",
      toClass: "FACT",
      enforcementScore: 90,
      rationale: "well cited",
    });
    expect(captured.output()).toBe(
      "✓ Promoted to FACT — enforcement 100 (mem_0123456789abcdef).\n" +
        "  Never run vitest in watch mode on CI",
    );
  });

  it("--json emits the promoted record", async () => {
    const promoted = record({ memoryClass: "FACT", enforcementScore: 100 });
    apiPostOrThrow.mockResolvedValue(promoted);
    const captured = captureWriter();
    await handleMemoryPromote(
      "mem_x",
      { to: "fact", json: true },
      captured.writer,
    );
    expect(JSON.parse(captured.output())).toEqual(promoted);
  });
});

describe("memory demote", () => {
  it("requires --to", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryDemote("mem_x", {}, captured.writer),
    ).rejects.toThrow("Missing --to. Use `--to rule` or `--to observation`.");
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("rejects a --to outside rule|observation", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryDemote("mem_x", { to: "fact" }, captured.writer),
    ).rejects.toThrow('Invalid --to "fact". Use "rule" or "observation".');
  });

  it("rejects a non-integer --enforcement", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryDemote(
        "mem_x",
        { to: "rule", enforcement: "1.5" },
        captured.writer,
      ),
    ).rejects.toThrow(
      'Invalid --enforcement "1.5". Use an integer between 1 and 100.',
    );
  });

  it("demotes to OBSERVATION and renders the cleared enforcement as —", async () => {
    apiPostOrThrow.mockResolvedValue(
      record({ memoryClass: "OBSERVATION", enforcementScore: null }),
    );
    const captured = captureWriter();
    await handleMemoryDemote(
      "mem_x",
      { to: "observation", rationale: "too broad" },
      captured.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/demote", {
      memoryId: "mem_x",
      toClass: "OBSERVATION",
      rationale: "too broad",
    });
    expect(captured.output()).toBe(
      "✓ Demoted to OBSERVATION — enforcement — (mem_0123456789abcdef).\n" +
        "  Never run vitest in watch mode on CI",
    );
  });
});

describe("memory dismiss", () => {
  it("dismisses with restore defaulted to false", async () => {
    apiPostOrThrow.mockResolvedValue({ memoryId: "mem_x", dismissed: true });
    const captured = captureWriter();
    await handleMemoryDismiss("mem_x", {}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/promotion/dismiss",
      { memoryId: "mem_x", restore: false },
    );
    expect(captured.output()).toBe(
      "✓ Dismissed mem_x from the promotion queue.",
    );
  });

  it("--restore restores the candidate and reports it", async () => {
    apiPostOrThrow.mockResolvedValue({ memoryId: "mem_x", dismissed: false });
    const captured = captureWriter();
    await handleMemoryDismiss("mem_x", { restore: true }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/promotion/dismiss",
      { memoryId: "mem_x", restore: true },
    );
    expect(captured.output()).toBe("✓ Restored mem_x to the promotion queue.");
  });
});

const stats = {
  totals: { citations: 12, executions: 4, memoriesCited: 3, nodesCited: 2 },
  byInfluence: { DECISIVE: 5, IGNORED: 1 },
  byCompliance: { COMPLIED: 6 },
  daily: [],
  topMemories: [
    {
      memoryId: "mem_aaaa11112222",
      publicId: "M-2",
      lesson: "Lint before push",
      memoryClass: "RULE",
      memoryKind: "gotcha",
      citationCount: 5,
      decisiveCount: 2,
      contributingCount: 1,
      consideredCount: 1,
      ignoredCount: 1,
      violationCount: 0,
    },
  ],
  leastUsefulMemories: [],
  mostViolatedRules: [],
  topNodes: [
    {
      node: { id: "n1", label: "App", displayName: "web", properties: {} },
      citationCount: 4,
      decisiveCount: 1,
    },
  ],
};

describe("memory citations", () => {
  it("applies the client defaults (30 days, top 10) and renders the rollup sections", async () => {
    apiPostOrThrow.mockResolvedValue(stats);
    const captured = captureWriter();
    await handleMemoryCitations({}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/citations/stats",
      { days: 30, limit: 10 },
    );
    const out = captured.output();
    expect(out).toContain(
      "Citations: 12 across 4 executions — 3 memories, 2 nodes cited.",
    );
    expect(out).toContain("  influence: DECISIVE 5, IGNORED 1");
    expect(out).toContain("  compliance: COMPLIED 6");
    expect(out).toContain("Most-cited memories:");
    expect(out).toContain(
      "mem_aaaa  cites:  5 dec:  2 viol:  0  Lint before push",
    );
    expect(out).toContain("web [App]  cites:  4 dec:  1");
    expect(out).not.toContain("Least-useful");
  });

  it("passes parsed --days and --limit through", async () => {
    apiPostOrThrow.mockResolvedValue(stats);
    const captured = captureWriter();
    await handleMemoryCitations({ days: "7", limit: "5" }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/citations/stats",
      { days: 7, limit: 5 },
    );
  });

  it("rejects a non-integer --days", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryCitations({ days: "soon" }, captured.writer),
    ).rejects.toThrow('Invalid --days "soon". Use an integer.');
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("--json emits the raw rollup", async () => {
    apiPostOrThrow.mockResolvedValue(stats);
    const captured = captureWriter();
    await handleMemoryCitations({ json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual(stats);
  });
});

describe("memory candidates", () => {
  it("defaults limit 3 and prints the empty-queue message", async () => {
    apiPostOrThrow.mockResolvedValue({ candidates: [] });
    const captured = captureWriter();
    await handleMemoryCandidates({}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/promotion/candidates",
      { limit: 3 },
    );
    expect(captured.output()).toBe(
      "No promotion candidates right now — no OBSERVATIONs have enough citation pressure yet.",
    );
  });

  it("parses --limit and renders a row per candidate", async () => {
    apiPostOrThrow.mockResolvedValue({
      candidates: [
        {
          id: "cand_0000abcd",
          publicId: "M-3",
          lesson: "Use captureWriter in the REPL",
          memoryKind: "convention-deviation",
          citationCount: 9,
          influenceCount: 4,
          confidenceScore: 71.2,
        },
      ],
    });
    const captured = captureWriter();
    await handleMemoryCandidates({ limit: "2" }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "agent/memory/promotion/candidates",
      { limit: 2 },
    );
    const out = captured.output();
    expect(out).toContain("cand_000");
    expect(out).toContain("convention-deviation");
    expect(out).toContain("cites:  9");
    expect(out).toContain("Use captureWriter in the REPL");
  });

  it("rejects a non-integer --limit", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryCandidates({ limit: "many" }, captured.writer),
    ).rejects.toThrow('Invalid --limit "many". Use an integer.');
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });
});

describe("memory rm", () => {
  it("deletes the memory and confirms", async () => {
    apiPostOrThrow.mockResolvedValue({ deleted: true, memoryId: "mem_x" });
    const captured = captureWriter();
    await handleMemoryRemove("mem_x", captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/delete", {
      memoryId: "mem_x",
    });
    expect(captured.output()).toBe("✓ Deleted memory mem_x.");
  });

  it("fails when the server reports nothing deleted", async () => {
    apiPostOrThrow.mockResolvedValue({ deleted: false, memoryId: "mem_x" });
    const captured = captureWriter();
    await expect(handleMemoryRemove("mem_x", captured.writer)).rejects.toThrow(
      "No memory mem_x found in this workspace.",
    );
  });
});

/** One proposed record, as parse_markdown_import returns it. */
function row(over: Record<string, unknown> = {}) {
  return {
    file: "docs/rules.md",
    line: 2,
    origin: "split",
    lineage: "a-intel.docs.rules.prefer-rg",
    label: "Prefer rg",
    statement: "Prefer rg over grep.",
    kind: "preference",
    kindReason: "It states a tool preference.",
    force: "may",
    forceWords: "Prefer",
    effect: null,
    tokens: 6,
    duplicate: null,
    conflict: null,
    action: "add",
    frontmatter: null,
    ...over,
  };
}

const parsedFile = {
  filename: "docs/rules.md",
  target: "records",
  detected: "records",
  reason: "The file holds prose, so its statements become records.",
  records: 1,
  policies: 0,
  error: null,
};

describe("memory import", () => {
  it("refuses an empty file list", async () => {
    const captured = captureWriter();
    await expect(handleMemoryImport([], {}, captured.writer)).rejects.toThrow(
      "Nothing to import. Pass one or more Markdown files, such as `oxagen memory import CLAUDE.md`.",
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("collects unreadable and empty files on stderr and fails when none survive", async () => {
    readFile.mockImplementation(async (path) => {
      if (path === "bad.md") throw new Error("ENOENT");
      return "   \n";
    });
    const captured = captureWriter();
    await expect(
      handleMemoryImport(["bad.md", "empty.md"], {}, captured.writer),
    ).rejects.toThrow("No readable, non-empty files to import.");
    const out = captured.output();
    expect(out).toContain("Skipped files that are empty or unreadable:");
    expect(out).toContain("bad.md");
    expect(out).toContain("empty.md (empty)");
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("previews records without --yes: parse only, as records, with the path from here", async () => {
    readFile.mockResolvedValue("# rules\n- Prefer rg over grep.\n");
    apiPostOrThrow.mockResolvedValue({
      files: [{ ...parsedFile, filename: "notes.md", error: "The model found no durable guidance in the file." }],
      records: [row()],
      policies: [],
    });
    const captured = captureWriter();
    await handleMemoryImport(["docs/rules.md"], {}, captured.writer);
    expect(readFile).toHaveBeenCalledWith("docs/rules.md", "utf8");
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
    expect(apiPostOrThrow).toHaveBeenCalledWith("context/steering/import/parse", {
      documents: [
        {
          filename: "docs/rules.md",
          content: "# rules\n- Prefer rg over grep.\n",
          target: "records",
        },
      ],
    });
    const out = captured.output();
    expect(out).toContain("Prefer rg over grep.");
    expect(out).toContain("1 proposed record.");
    expect(out).toContain("notes.md: The model found no durable guidance in the file.");
    expect(out).toContain("Run again with --yes to open the steering PR.");
  });

  it("sends files in calls of 25", async () => {
    readFile.mockResolvedValue("Use rg.\n");
    apiPostOrThrow.mockResolvedValue({ files: [], records: [], policies: [] });
    const paths = Array.from({ length: 26 }, (_, i) => `r${i}.md`);
    const captured = captureWriter();
    await handleMemoryImport(paths, {}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledTimes(2);
    const sizes = apiPostOrThrow.mock.calls.map(
      ([, body]) => (body as { documents: unknown[] }).documents.length,
    );
    expect(sizes).toEqual([25, 1]);
    expect(captured.output()).toBe("No records were proposed.");
  });

  it("--json preview emits the parse output and never commits", async () => {
    readFile.mockResolvedValue("# rules\n");
    apiPostOrThrow.mockResolvedValue({ files: [parsedFile], records: [row()], policies: [] });
    const captured = captureWriter();
    await handleMemoryImport(["rules.md"], { json: true }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured.output())).toEqual({
      files: [parsedFile],
      records: [row()],
    });
  });

  it("--yes with no record marked add fails instead of committing (negative)", async () => {
    readFile.mockResolvedValue("# rules\n");
    apiPostOrThrow.mockResolvedValue({
      files: [parsedFile],
      records: [row({ action: "skip", duplicate: { lineage: "a-intel.rg", path: null, published: true } })],
      policies: [],
    });
    const captured = captureWriter();
    await expect(
      handleMemoryImport(["rules.md"], { yes: true }, captured.writer),
    ).rejects.toThrow("No record is marked add, so there is no steering PR to open.");
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
  });

  it("--yes leaves a conflicting row out, names it, and opens the steering PR", async () => {
    readFile.mockResolvedValue("# rules\n");
    const conflict = row({
      lineage: "a-intel.rules.friday-deploys",
      kind: "constraint",
      force: "must",
      effect: "require",
      action: null,
      conflict: { lineage: "a-intel.no-friday-deploys", path: null, published: true },
    });
    apiPostOrThrow.mockImplementation(async (path) =>
      path === "context/steering/import/parse"
        ? { files: [parsedFile], records: [row(), conflict], policies: [] }
        : {
            pullRequest: {
              number: 7,
              url: "https://github.com/a-intel/steering/pull/7",
              branch: "steering/import-2026-09-30",
              headSha: "abc123",
            },
            paths: ["steering/preferences/a-intel.docs.rules.prefer-rg.md"],
            records: 1,
            policies: 0,
            skipped: 1,
          },
    );
    const captured = captureWriter();
    await handleMemoryImport(["rules.md"], { yes: true }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenNthCalledWith(2, "context/steering/import/commit", {
      records: [row(), { ...conflict, action: "skip" }],
      policies: [],
    });
    const out = captured.output();
    expect(out).toContain("Left out docs/rules.md:2 (a-intel.rules.friday-deploys)");
    expect(out).toContain("Opened steering PR #7 on steering/import-2026-09-30 with 1 record.");
    expect(out).toContain("https://github.com/a-intel/steering/pull/7");
    expect(out).toContain("1 row was left out.");
  });
});

describe("remember", () => {
  it("refuses blank text", async () => {
    const captured = captureWriter();
    await expect(handleRemember("   ", {}, captured.writer)).rejects.toThrow(
      'Nothing to remember. Pass the memory text, e.g. `oxagen remember "…"`.',
    );
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range --enforcement", async () => {
    const captured = captureWriter();
    await expect(
      handleRemember("lesson", { enforcement: "101" }, captured.writer),
    ).rejects.toThrow(
      'Invalid --enforcement "101". Use an integer between 1 and 100.',
    );
  });

  it("rejects an unknown --class before calling the API", async () => {
    const captured = captureWriter();
    await expect(
      handleRemember("lesson", { class: "hunch" }, captured.writer),
    ).rejects.toThrow(
      'Invalid class "hunch". Use one of: OBSERVATION, RULE, FACT.',
    );
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("trims the text, pins class/kind, and prints the capture summary", async () => {
    apiPostOrThrow.mockResolvedValue({
      memory: record(),
      inferred: {
        memoryClass: "OBSERVATION",
        memoryKind: "gotcha",
        classified: false,
      },
    });
    const captured = captureWriter();
    await handleRemember(
      "  always use rg  ",
      {
        class: "observation",
        kind: "gotcha",
        enforcement: "40",
        node: "app:web",
      },
      captured.writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/remember", {
      text: "always use rg",
      memoryClass: "OBSERVATION",
      memoryKind: "gotcha",
      enforcementScore: 40,
      nodeRef: "app:web",
    });
    expect(captured.output()).toBe(
      "✓ Remembered — class OBSERVATION, kind gotcha (set).\n" +
        "  id: mem_0123456789abcdef\n" +
        "  Never run vitest in watch mode on CI",
    );
  });

  it("--json emits the raw remember result", async () => {
    const result = {
      memory: record(),
      inferred: { memoryClass: "RULE", memoryKind: "gotcha", classified: true },
    };
    apiPostOrThrow.mockResolvedValue(result);
    const captured = captureWriter();
    await handleRemember("always use rg", { json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual(result);
  });
});

describe("one-shot failure contract", () => {
  it("with the default writer a validation failure writes stderr and exits 1", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(1)");
    });
    const errWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await expect(handleMemoryEdit("mem_x", {})).rejects.toThrow(
        "process.exit(1)",
      );
      expect(exit).toHaveBeenCalledWith(1);
      expect(errWrite).toHaveBeenCalledWith(
        "Nothing to edit. Pass at least one of --lesson, --kind, or --source.\n",
      );
    } finally {
      exit.mockRestore();
      errWrite.mockRestore();
    }
  });
});
