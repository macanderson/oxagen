import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the network calls and keep the real formatters (formatImportRows and
// formatImportPullRequest), so the printed output is read end to end through
// the one-shot stdout and exit path.
const mocks = vi.hoisted(() => ({
  parseMarkdownImport: vi.fn(),
  commitMarkdownImport: vi.fn(),
}));

vi.mock("../../lib/memory-client.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/memory-client.js")>();
  return {
    ...actual,
    parseMarkdownImport: mocks.parseMarkdownImport,
    commitMarkdownImport: mocks.commitMarkdownImport,
  };
});

import { handleMemoryImport, MEMORY_IMPORT_CAPABILITIES } from "../memory.js";

let dir: string;
let out: string[];
let err: string[];

function md(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    file: "CLAUDE.md",
    line: 3,
    origin: "split",
    lineage: "a-intel.claude.no-push-to-main",
    label: "No push to main",
    statement: "Never push to main.",
    kind: "constraint",
    kindReason: "It forbids an action.",
    force: "must",
    forceWords: "Never",
    effect: "forbid",
    tokens: 5,
    duplicate: null,
    conflict: null,
    action: "add",
    frontmatter: null,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-md-import-"));
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
  // fail() calls process.exit(1). Make it throw so a test can assert on it.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.parseMarkdownImport.mockReset();
  mocks.commitMarkdownImport.mockReset();
  rmSync(dir, { recursive: true, force: true });
});

const text = () => out.join("");
const errText = () => err.join("");

describe("handleMemoryImport", () => {
  it("names the two capabilities it calls", () => {
    expect(MEMORY_IMPORT_CAPABILITIES).toEqual([
      "parse_markdown_import",
      "commit_markdown_import",
    ]);
  });

  it("previews the records with their kind, force, and words, and writes nothing without --yes", async () => {
    mocks.parseMarkdownImport.mockResolvedValue({
      files: [],
      records: [row(), row({ statement: "Prefer rg.", kind: "preference", force: "may", forceWords: "Prefer", effect: null })],
      policies: [],
    });

    await handleMemoryImport([md("CLAUDE.md", "Never push to main.")], {});

    expect(mocks.parseMarkdownImport).toHaveBeenCalledTimes(1);
    expect(mocks.parseMarkdownImport.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ content: "Never push to main.", target: "records" }),
    ]);
    expect(mocks.commitMarkdownImport).not.toHaveBeenCalled();
    expect(text()).toContain("constraint (forbid)");
    expect(text()).toContain('"Never"');
    expect(text()).toContain("2 proposed records. The must and should rows marked add load 5 tokens on every request.");
    expect(text()).toContain("Run again with --yes to open the steering PR.");
  });

  it("opens the steering PR with --yes and prints it", async () => {
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records: [row()], policies: [] });
    mocks.commitMarkdownImport.mockResolvedValue({
      pullRequest: {
        number: 12,
        url: "https://github.com/a-intel/steering/pull/12",
        branch: "steering/import-2026-09-30",
        headSha: "abc",
      },
      paths: ["steering/constraints/a-intel.claude.no-push-to-main.md"],
      records: 1,
      policies: 0,
      skipped: 0,
    });

    await handleMemoryImport([md("CLAUDE.md", "Never push to main.")], { yes: true });

    expect(mocks.commitMarkdownImport).toHaveBeenCalledWith({ records: [row()] });
    expect(text()).toContain("Opened steering PR #12 on steering/import-2026-09-30 with 1 record.");
    expect(text()).toContain("Nothing steers an agent until the PR merges.");
  });

  it("emits the commit result as JSON with --yes --json", async () => {
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records: [row()], policies: [] });
    mocks.commitMarkdownImport.mockResolvedValue({
      pullRequest: { number: 3, url: "u", branch: "b", headSha: "h" },
      paths: [],
      records: 1,
      policies: 0,
      skipped: 0,
    });
    await handleMemoryImport([md("CLAUDE.md", "x")], { yes: true, json: true });
    expect(JSON.parse(text()).pullRequest.number).toBe(3);
  });

  it("fails when no files are passed (negative)", async () => {
    await expect(handleMemoryImport([], {})).rejects.toThrow("process.exit:1");
    expect(errText()).toContain("Nothing to import");
  });

  it("fails when no file is readable (negative)", async () => {
    await expect(handleMemoryImport([join(dir, "ghost.md")], {})).rejects.toThrow(
      "process.exit:1",
    );
    expect(errText()).toContain("No readable, non-empty files to import.");
  });
});
