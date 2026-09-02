import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the network calls; keep the real formatters (formatImportDrafts /
// formatImportResults) so the printed output is exercised end-to-end.
const mocks = vi.hoisted(() => ({
  parseImportMemories: vi.fn(),
  commitImportMemories: vi.fn(),
}));

vi.mock("../../lib/memory-client.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/memory-client.js")>();
  return {
    ...actual,
    parseImportMemories: mocks.parseImportMemories,
    commitImportMemories: mocks.commitImportMemories,
  };
});

import { handleMemoryImport } from "../memory.js";

let dir: string;
let out: string[];
let err: string[];

function md(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    lesson: "Never push to main.",
    memoryKind: "constraint",
    memoryClass: "RULE",
    enforcementScore: 95,
    source: "user",
    nodeRef: "user-memory",
    sourceDocument: "rules.md",
    classified: true,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-mem-import-"));
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation(
    (s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    },
  );
  vi.spyOn(process.stderr, "write").mockImplementation(
    (s: string | Uint8Array) => {
      err.push(String(s));
      return true;
    },
  );
  // fail() calls process.exit(1); make it throw so tests can assert on it.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.parseImportMemories.mockReset();
  mocks.commitImportMemories.mockReset();
  rmSync(dir, { recursive: true, force: true });
});

const text = () => out.join("");
const errText = () => err.join("");

describe("handleMemoryImport", () => {
  it("previews drafts and writes nothing without --yes", async () => {
    mocks.parseImportMemories.mockResolvedValue({
      drafts: [
        draft({ lesson: "Lesson one." }),
        draft({ lesson: "Lesson two." }),
      ],
      documentCount: 1,
      skipped: [],
    });
    const file = md("rules.md", "- never push to main");

    await handleMemoryImport([file], {});

    expect(mocks.parseImportMemories).toHaveBeenCalledTimes(1);
    // Filename is the basename, content is the file body.
    expect(mocks.parseImportMemories.mock.calls[0]?.[0]).toEqual([
      { filename: "rules.md", content: "- never push to main" },
    ]);
    expect(mocks.commitImportMemories).not.toHaveBeenCalled();
    expect(text()).toContain("Lesson one.");
    expect(text()).toContain("Re-run with --yes to import");
  });

  it("emits JSON of the parsed drafts (no commit) with --json and no --yes", async () => {
    mocks.parseImportMemories.mockResolvedValue({
      drafts: [draft({ lesson: "Preview me." })],
      documentCount: 1,
      skipped: [],
    });
    await handleMemoryImport([md("rules.md", "- content")], { json: true });

    expect(mocks.commitImportMemories).not.toHaveBeenCalled();
    const parsed = JSON.parse(text());
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.drafts[0].lesson).toBe("Preview me.");
  });

  it("passes --node through as the default anchor", async () => {
    mocks.parseImportMemories.mockResolvedValue({
      drafts: [draft()],
      documentCount: 1,
      skipped: [],
    });
    const file = md("rules.md", "- content");

    await handleMemoryImport([file], { node: "team:platform" });
    expect(mocks.parseImportMemories.mock.calls[0]?.[1]).toBe("team:platform");
  });

  it("commits the parsed drafts with --yes and prints the result summary", async () => {
    mocks.parseImportMemories.mockResolvedValue({
      drafts: [draft({ lesson: "Lesson one." })],
      documentCount: 1,
      skipped: [],
    });
    mocks.commitImportMemories.mockResolvedValue({
      results: [
        { lesson: "Lesson one.", ok: true, memoryId: "m_1", error: null },
      ],
      imported: 1,
      failed: 0,
    });
    const file = md("rules.md", "- content");

    await handleMemoryImport([file], { yes: true });

    expect(mocks.commitImportMemories).toHaveBeenCalledTimes(1);
    expect(mocks.commitImportMemories.mock.calls[0]?.[0]).toHaveLength(1);
    expect(text()).toContain("Imported 1 memory, 0 failed");
  });

  it("emits JSON for the commit result with --yes --json", async () => {
    mocks.parseImportMemories.mockResolvedValue({
      drafts: [draft()],
      documentCount: 1,
      skipped: [],
    });
    mocks.commitImportMemories.mockResolvedValue({
      results: [{ lesson: "L", ok: true, memoryId: "m_1", error: null }],
      imported: 1,
      failed: 0,
    });
    await handleMemoryImport([md("rules.md", "- content")], {
      yes: true,
      json: true,
    });
    const parsed = JSON.parse(text());
    expect(parsed.imported).toBe(1);
  });

  it("skips unreadable / empty files and reports them", async () => {
    mocks.parseImportMemories.mockResolvedValue({
      drafts: [draft()],
      documentCount: 1,
      skipped: [],
    });
    const good = md("good.md", "- real content");
    const empty = md("empty.md", "   ");
    const missing = join(dir, "nope.md");

    await handleMemoryImport([good, empty, missing], {});

    expect(errText()).toContain("Skipped unreadable/empty files");
    expect(errText()).toContain("empty.md");
    expect(errText()).toContain("nope.md");
    // Only the readable, non-empty file is sent.
    expect(mocks.parseImportMemories.mock.calls[0]?.[0]).toEqual([
      { filename: "good.md", content: "- real content" },
    ]);
  });

  it("fails when no files are passed", async () => {
    await expect(handleMemoryImport([], {})).rejects.toThrow("process.exit:1");
    expect(errText()).toContain("Nothing to import");
  });

  it("fails when no documents are readable", async () => {
    await expect(
      handleMemoryImport([join(dir, "ghost.md")], {}),
    ).rejects.toThrow("process.exit:1");
    expect(errText()).toContain("No readable, non-empty documents");
  });

  it("fails on --yes when extraction yields zero drafts", async () => {
    mocks.parseImportMemories.mockResolvedValue({
      drafts: [],
      documentCount: 0,
      skipped: [{ filename: "toc.md", reason: "No durable rules found." }],
    });
    await expect(
      handleMemoryImport([md("toc.md", "# Table of contents")], { yes: true }),
    ).rejects.toThrow("process.exit:1");
    expect(errText()).toContain("No memories could be extracted");
    expect(mocks.commitImportMemories).not.toHaveBeenCalled();
  });
});
