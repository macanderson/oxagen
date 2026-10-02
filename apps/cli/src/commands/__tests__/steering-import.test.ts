/**
 * `oxagen steering import`: the folder walk, the calls of 25, the preview of
 * records and policies, and --yes. The two network calls are mocked and the
 * formatters are real, so the printed output is read end to end. The files
 * are real, in a temporary folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const mocks = vi.hoisted(() => ({
  parseMarkdownImport: vi.fn(),
  commitMarkdownImport: vi.fn(),
}));

// The real file system, with readdir wrapped so one test can make a folder unreadable.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

vi.mock("../../lib/memory-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/memory-client.js")>();
  return {
    ...actual,
    parseMarkdownImport: mocks.parseMarkdownImport,
    commitMarkdownImport: mocks.commitMarkdownImport,
  };
});

import { readdir } from "node:fs/promises";
import type { MarkdownImportPolicy } from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { captureWriter } from "../../lib/capture-writer.js";
import { formatImportPolicies, formatImportPullRequest } from "../../lib/memory-client.js";
import { importFilename, reconcileImportPolicies } from "../../lib/markdown-import.js";
import { buildProgram } from "../../program.js";
import {
  findMarkdownFiles,
  handleSteeringImport,
  STEERING_IMPORT_CAPABILITIES,
} from "../steering-import.js";

let dir: string;

/** A path under the temporary folder. */
const at = (rel: string): string => join(dir, rel);

/** Write a file under the temporary folder, making its folders. */
function put(rel: string, body = "Never push to main.\n"): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    file: "repo/AGENTS.md",
    line: 3,
    origin: "split",
    lineage: "a-intel.repo.agents.no-push-to-main",
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

function policy(overrides: Record<string, unknown> = {}) {
  return {
    file: "repo/policy/no-force-push.md",
    path: "policy/no-force-push.cedar",
    text: '@id("no-force-push")\nforbid (principal, action, resource);\n',
    statements: [{ id: "no-force-push", line: 3, effect: "forbid" }],
    issues: [],
    duplicate: null,
    replaces: false,
    action: "add",
    ...overrides,
  };
}

function parsed(filename: string, target: string, overrides: Record<string, unknown> = {}) {
  return {
    filename,
    target,
    detected: target,
    reason: "The file holds prose, so its statements become records.",
    records: target === "records" ? 1 : 0,
    policies: target === "policies" ? 1 : 0,
    error: null,
    ...overrides,
  };
}

const pullRequest = (records: number, policies: number) => ({
  pullRequest: {
    number: 9,
    url: "https://github.com/a-intel/steering/pull/9",
    branch: "steering/import-2026-10-01",
    headSha: "abc123",
  },
  paths: [],
  records,
  policies,
  skipped: 0,
});

/** The documents each parse call was sent. */
function sent(): { filename: string; content: string; target?: string }[][] {
  return mocks.parseMarkdownImport.mock.calls.map(
    ([documents]) => documents as { filename: string; content: string; target?: string }[],
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-steering-import-"));
  // Run from the temporary folder, so each file is sent under its path from here.
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.parseMarkdownImport.mockReset();
  mocks.commitMarkdownImport.mockReset();
  rmSync(dir, { recursive: true, force: true });
});

describe("oxagen steering import", () => {
  it("names the two capabilities it calls", () => {
    expect(STEERING_IMPORT_CAPABILITIES).toEqual([
      "parse_markdown_import",
      "commit_markdown_import",
    ]);
  });

  it("registers under `oxagen steering` with --as, --yes, and --json", () => {
    const steering = buildProgram().commands.find((c) => c.name() === "steering");
    const command = steering?.commands.find((c) => c.name() === "import");
    expect(command, "the import subcommand must be registered").toBeDefined();
    expect(command?.registeredArguments.map((a) => [a.name(), a.variadic, a.required])).toEqual([
      ["paths", true, true],
    ]);
    expect(command?.options.map((o) => o.long)).toEqual(["--as", "--yes", "--json"]);
  });
});

describe("findMarkdownFiles", () => {
  it("searches a folder for .md, .markdown, and .mdx files in name order, and skips dot-folders, node_modules, and folder links", async () => {
    put("repo/CLAUDE.md");
    put("repo/AGENTS.md");
    put("repo/docs/b.markdown");
    put("repo/docs/a.mdx");
    put("repo/docs/deep/c.MD");
    put("repo/docs/notes.txt");
    put("repo/.git/info.md");
    put("repo/.claude/rules.md");
    put("repo/node_modules/pkg/README.md");
    // A link to a folder outside the walk, so a walk that followed it would find linked.md.
    put("outside/linked.md");
    symlinkSync(at("outside"), at("repo/docs-link"));

    const walk = await findMarkdownFiles([join(dir, "repo")]);

    expect(walk.unreadable).toEqual([]);
    expect(walk.sources.map((s) => relative(dir, s.path))).toEqual([
      "repo/AGENTS.md",
      "repo/CLAUDE.md",
      "repo/docs/a.mdx",
      "repo/docs/b.markdown",
      "repo/docs/deep/c.MD",
    ]);
    expect(new Set(walk.sources.map((s) => s.folder))).toEqual(new Set([join(dir, "repo")]));
  });

  it("takes a named file as given, searches a named dot-folder, and reads a file reached twice once", async () => {
    const agents = put("repo/AGENTS.md");
    symlinkSync(agents, join(dir, "repo/CLAUDE.md"));
    const notes = put("repo/notes.txt");
    put("repo/.claude/rules.md");

    const walk = await findMarkdownFiles([
      notes,
      join(dir, "repo/.claude"),
      join(dir, "repo"),
      agents,
    ]);

    expect(walk.sources).toEqual([
      { path: notes },
      { path: join(dir, "repo/.claude/rules.md"), folder: join(dir, "repo/.claude") },
      // CLAUDE.md links to AGENTS.md, so the walk reads AGENTS.md once.
      { path: agents, folder: join(dir, "repo") },
    ]);
  });

  it("reports a path that does not exist and keeps the rest (negative)", async () => {
    const agents = put("AGENTS.md");
    const walk = await findMarkdownFiles([join(dir, "ghost"), agents]);
    expect(walk.unreadable).toEqual([join(dir, "ghost")]);
    expect(walk.sources).toEqual([{ path: agents }]);
  });
});

describe("findMarkdownFiles folder errors", () => {
  it("reports a folder it cannot list (negative)", async () => {
    put("repo/AGENTS.md");
    vi.mocked(readdir).mockRejectedValueOnce(new Error("EACCES: permission denied"));
    const walk = await findMarkdownFiles([at("repo")]);
    expect(walk).toEqual({ sources: [], unreadable: [at("repo")] });
  });
});

describe("importFilename", () => {
  it("sends a file under its path from here", () => {
    expect(importFilename(join(dir, "docs/rules.md"))).toBe("docs/rules.md");
  });

  it("sends a file a walk found elsewhere under its path from the folder's parent", () => {
    vi.mocked(process.cwd).mockReturnValue(join(dir, "elsewhere"));
    expect(importFilename(join(dir, "notes/a/b.md"), join(dir, "notes"))).toBe("notes/a/b.md");
    expect(importFilename(join(dir, "notes/a/b.md"))).toBe("b.md");
  });

  it("cuts a name longer than 256 characters to the end of its base name", () => {
    const long = `${"x".repeat(300)}.md`;
    expect(importFilename(join(dir, "docs", long))).toBe(long.slice(-256));
  });
});

describe("handleSteeringImport preview", () => {
  it("previews a folder as records and policies, leaves each target to parse, and writes nothing", async () => {
    put("repo/AGENTS.md", "Never push to main.\n");
    put("repo/README.md", "# Index\n");
    put("repo/policy/no-force-push.md", "```cedar\nforbid (principal, action, resource);\n```\n");
    mocks.parseMarkdownImport.mockResolvedValue({
      files: [
        parsed("repo/AGENTS.md", "records"),
        parsed("repo/README.md", "skip", {
          reason: "A README or index file describes other files.",
        }),
        parsed("repo/policy/no-force-push.md", "policies", {
          reason: "The file holds a cedar block or a top-level permit or forbid statement.",
        }),
      ],
      records: [record()],
      policies: [policy()],
    });
    const captured = captureWriter();

    await handleSteeringImport([at("repo")], {}, captured.writer);

    expect(sent()).toEqual([
      [
        { filename: "repo/AGENTS.md", content: "Never push to main.\n" },
        { filename: "repo/README.md", content: "# Index\n" },
        {
          filename: "repo/policy/no-force-push.md",
          content: "```cedar\nforbid (principal, action, resource);\n```\n",
        },
      ],
    ]);
    expect(mocks.commitMarkdownImport).not.toHaveBeenCalled();
    const out = captured.output();
    expect(out).toContain("constraint (forbid)");
    expect(out).toContain("1 proposed record.");
    expect(out).toContain("policy/no-force-push.cedar");
    expect(out).toContain("1 proposed policy file.");
    expect(out).toContain("Skipped repo/README.md: A README or index file describes other files.");
    expect(out).toContain("Run again with --yes to open the steering PR.");
  });

  it("shows a policy's duplicate, the file it replaces, and its issues, and no records grid when there are no records", async () => {
    put("security.md");
    mocks.parseMarkdownImport.mockResolvedValue({
      files: [parsed("security.md", "policies", { error: null })],
      records: [],
      policies: [
        policy({
          file: "security.md",
          path: "policy/security.cedar",
          duplicate: { path: "policy/old-security.cedar" },
          replaces: true,
          issues: [
            { statement: 1, id: "security", line: 4, message: "Statement 1 has no effect." },
            { statement: null, id: null, line: null, message: "The block holds no statement." },
          ],
          action: "skip",
        }),
      ],
    });
    const captured = captureWriter();

    await handleSteeringImport([at("security.md")], {}, captured.writer);

    const out = captured.output();
    expect(out).not.toContain("No records were proposed.");
    expect(out).toContain("Duplicate of policy/old-security.cedar.");
    expect(out).toContain("Replaces the published file at policy/security.cedar.");
    expect(out).toContain("Line 4: Statement 1 has no effect.");
    expect(out).toContain("\n      The block holds no statement.");
    expect(out).toContain(
      "1 proposed policy file. A file with an issue stays skip. Fix its Markdown and import it again.",
    );
  });

  it("prints a file parse could not read", async () => {
    put("notes.md");
    mocks.parseMarkdownImport.mockResolvedValue({
      files: [parsed("notes.md", "records", { error: "The model could not split the file: timeout" })],
      records: [],
      policies: [],
    });
    const captured = captureWriter();
    await handleSteeringImport([at("notes.md")], {}, captured.writer);
    expect(captured.output()).toBe(
      "No records were proposed.\n  notes.md: The model could not split the file: timeout",
    );
  });

  it("--as policies sets the target on every file", async () => {
    put("a.md");
    put("b.md");
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records: [], policies: [] });
    await handleSteeringImport([at("a.md"), at("b.md")], { as: "policies" }, captureWriter().writer);
    expect(sent()[0]?.map((d) => d.target)).toEqual(["policies", "policies"]);
  });

  it("--as Records takes the name in any case", async () => {
    put("a.md");
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records: [], policies: [] });
    await handleSteeringImport([at("a.md")], { as: "Records" }, captureWriter().writer);
    expect(sent()[0]?.map((d) => d.target)).toEqual(["records"]);
  });

  it("--json prints the files, the records, the policies, and the PR file count", async () => {
    put("a.md");
    mocks.parseMarkdownImport.mockResolvedValue({
      files: [parsed("a.md", "records")],
      records: [record({ file: "a.md" })],
      policies: [policy()],
    });
    const captured = captureWriter();
    await handleSteeringImport([at("a.md")], { json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual({
      files: [parsed("a.md", "records")],
      records: [record({ file: "a.md" })],
      policies: [policy()],
      pullRequestFiles: { count: 2, max: 299, message: null },
    });
  });

  it("skips a file longer than one parse call takes and sends the rest", async () => {
    put("big.md", "x".repeat(100_001));
    put("small.md");
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records: [], policies: [] });
    const captured = captureWriter();
    await handleSteeringImport([at("big.md"), at("small.md")], {}, captured.writer);
    expect(sent()[0]?.map((d) => d.filename)).toEqual(["small.md"]);
    expect(captured.output()).toContain(
      `Skipped files over 100,000 characters, the most one file may hold:\n  ${at("big.md")}`,
    );
  });
});

describe("handleSteeringImport batching", () => {
  it("sends 30 files in calls of 25, and skips the later of two policies that both become one file", async () => {
    for (let i = 0; i < 30; i += 1) put(`repo/f${String(i).padStart(2, "0")}.md`);
    const first = policy({ file: "repo/f00.md", path: "policy/security.cedar" });
    const again = policy({
      file: "repo/f25.md",
      path: "policy/security.cedar",
      statements: [{ id: "security-25", line: 2, effect: "permit" }],
    });
    mocks.parseMarkdownImport.mockImplementation(async (documents: { filename: string }[]) => ({
      files: [],
      records: [],
      // Each call checks only its own files, so neither call marks the clash.
      policies: documents[0]?.filename === "repo/f00.md" ? [first] : [again],
    }));
    mocks.commitMarkdownImport.mockResolvedValue(pullRequest(0, 1));
    const captured = captureWriter();

    await handleSteeringImport([at("repo")], { yes: true }, captured.writer);

    expect(sent().map((documents) => documents.length)).toEqual([25, 5]);
    expect(sent()[1]?.[0]?.filename).toBe("repo/f25.md");
    const clash = "repo/f00.md in this import also becomes policy/security.cedar. Rename one of the two files.";
    expect(mocks.commitMarkdownImport).toHaveBeenCalledWith({
      records: [],
      policies: [
        first,
        {
          ...again,
          issues: [{ statement: null, id: null, line: null, message: clash }],
          action: "skip",
        },
      ],
    });
    const out = captured.output();
    expect(out).toContain(`Left out policy/security.cedar from repo/f25.md: ${clash}`);
    expect(out).toContain("Opened steering PR #9 on steering/import-2026-10-01 with 1 policy file.");
  });

  it("marks a conflict between files sent in different calls, and --yes leaves it out", async () => {
    for (let i = 0; i < 26; i += 1) put(`repo/f${String(i).padStart(2, "0")}.md`);
    const forbids = record({
      file: "repo/f00.md",
      lineage: "a-intel.repo.f00.friday-deploys",
      statement: "Deploy on Fridays.",
    });
    const requires = record({
      file: "repo/f25.md",
      lineage: "a-intel.repo.f25.friday-deploys",
      statement: "Deploy on Fridays.",
      effect: "require",
    });
    mocks.parseMarkdownImport.mockImplementation(async (documents: { filename: string }[]) => ({
      files: [],
      records: documents[0]?.filename === "repo/f00.md" ? [forbids, record()] : [requires],
      policies: [],
    }));
    mocks.commitMarkdownImport.mockResolvedValue(pullRequest(2, 0));
    const captured = captureWriter();

    await handleSteeringImport([at("repo")], { yes: true }, captured.writer);

    const conflict = { lineage: "a-intel.repo.f00.friday-deploys", path: null, published: false };
    expect(mocks.commitMarkdownImport).toHaveBeenCalledWith({
      records: [forbids, record(), { ...requires, conflict, action: "skip" }],
      policies: [],
    });
    expect(captured.output()).toContain(
      "Left out repo/f25.md:3 (a-intel.repo.f25.friday-deploys): it conflicts with a-intel.repo.f00.friday-deploys.",
    );
  });

  it("marks a statement id two calls both use, and passes a policy already skip through", () => {
    const first = policy({ file: "a.md", path: "policy/a.cedar" });
    const skipped = policy({ file: "s.md", path: "policy/a.cedar", action: "skip" });
    const again = policy({ file: "b.md", path: "policy/b.cedar" });
    const [kept, passed, marked] = reconcileImportPolicies([
      first,
      skipped,
      again,
    ] as unknown as MarkdownImportPolicy[]);
    expect(kept).toBe(first);
    expect(passed).toBe(skipped);
    expect(marked).toEqual({
      ...again,
      action: "skip",
      issues: [
        {
          statement: null,
          id: "no-force-push",
          line: 3,
          message:
            "@id no-force-push is also in policy/a.cedar in this import. Give one of the two statements another @id.",
        },
      ],
    });
  });
});

describe("handleSteeringImport --yes", () => {
  it("opens the steering PR with the records and the policies, and leaves a conflict out", async () => {
    put("repo/AGENTS.md");
    const conflict = record({
      line: 7,
      lineage: "a-intel.repo.agents.friday-deploys",
      label: "Friday deploys",
      statement: "Deploy on Fridays after the freeze lifts.",
      effect: "require",
      forceWords: "Deploy",
      action: null,
      conflict: { lineage: "a-intel.no-friday-deploys", path: null, published: true },
    });
    mocks.parseMarkdownImport.mockResolvedValue({
      files: [parsed("repo/AGENTS.md", "records")],
      records: [record(), conflict],
      policies: [policy()],
    });
    mocks.commitMarkdownImport.mockResolvedValue(pullRequest(1, 1));
    const captured = captureWriter();

    await handleSteeringImport([at("repo")], { yes: true }, captured.writer);

    expect(mocks.commitMarkdownImport).toHaveBeenCalledWith({
      records: [record(), { ...conflict, action: "skip" }],
      policies: [policy()],
    });
    const out = captured.output();
    expect(out).toContain(
      "Left out repo/AGENTS.md:7 (a-intel.repo.agents.friday-deploys): it conflicts with a-intel.no-friday-deploys.",
    );
    expect(out).toContain(
      "Opened steering PR #9 on steering/import-2026-10-01 with 1 record and 1 policy file.",
    );
    expect(out).toContain("https://github.com/a-intel/steering/pull/9");
    expect(out).toContain("Nothing steers an agent until the PR merges.");
  });

  it("--json prints the commit result", async () => {
    put("a.md");
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records: [record()], policies: [] });
    mocks.commitMarkdownImport.mockResolvedValue(pullRequest(1, 0));
    const captured = captureWriter();
    await handleSteeringImport([at("a.md")], { yes: true, json: true }, captured.writer);
    expect(JSON.parse(captured.output()).pullRequest.number).toBe(9);
  });

  it("fails when no record or policy is marked add (negative)", async () => {
    put("a.md");
    mocks.parseMarkdownImport.mockResolvedValue({
      files: [],
      records: [record({ action: "skip" })],
      policies: [policy({ action: "skip" })],
    });
    const captured = captureWriter();
    await expect(
      handleSteeringImport([at("a.md")], { yes: true }, captured.writer),
    ).rejects.toThrow("No record or policy is marked add, so there is no steering PR to open.");
    expect(mocks.commitMarkdownImport).not.toHaveBeenCalled();
  });

  it("refuses rows that are more than one steering PR holds, counting the policies (negative)", async () => {
    put("a.md");
    const records = Array.from({ length: 299 }, (_, i) =>
      record({ lineage: `a-intel.a.tool-${i}`, statement: `Use tool ${i}.` }),
    );
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records, policies: [policy()] });
    const captured = captureWriter();
    await expect(
      handleSteeringImport([at("a.md")], { yes: true }, captured.writer),
    ).rejects.toThrow(
      "The import marks 300 records and policy files add, and one steering PR holds at most 299 files. Mark 1 of them skip, or import the files in smaller sets.",
    );
    expect(mocks.commitMarkdownImport).not.toHaveBeenCalled();
  });

  it("names a row that waits for a choice with no conflict recorded", async () => {
    put("a.md");
    mocks.parseMarkdownImport.mockResolvedValue({
      files: [],
      records: [record(), record({ lineage: "a-intel.a.other", statement: "Use rg.", action: null })],
      policies: [],
    });
    mocks.commitMarkdownImport.mockResolvedValue(pullRequest(1, 0));
    const captured = captureWriter();
    await handleSteeringImport([at("a.md")], { yes: true }, captured.writer);
    expect(captured.output()).toContain(
      "Left out repo/AGENTS.md:3 (a-intel.a.other): it conflicts with a published record.",
    );
  });

  it("fails with the API's message when a call fails (negative)", async () => {
    put("a.md");
    mocks.parseMarkdownImport.mockRejectedValue(new Error("Your role cannot import steering."));
    await expect(
      handleSteeringImport([at("a.md")], { yes: true }, captureWriter().writer),
    ).rejects.toThrow("Your role cannot import steering.");
  });
});

describe("handleSteeringImport limits", () => {
  it("previews rows that are more than one steering PR holds and says what to do instead of --yes", async () => {
    put("a.md");
    const records = Array.from({ length: 300 }, (_, i) =>
      record({ lineage: `a-intel.a.tool-${i}`, statement: `Use tool ${i}.` }),
    );
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records, policies: [] });
    const captured = captureWriter();
    await handleSteeringImport([at("a.md")], {}, captured.writer);
    const out = captured.output();
    expect(out).toContain(
      "The import marks 300 records and policy files add, and one steering PR holds at most 299 files.",
    );
    expect(out).not.toContain("Run again with --yes");
  });

  it("fails with a call's rejection when it is not an Error (negative)", async () => {
    put("a.md");
    mocks.parseMarkdownImport.mockRejectedValue("connection reset");
    await expect(
      handleSteeringImport([at("a.md")], {}, captureWriter().writer),
    ).rejects.toThrow("connection reset");
  });

  it("reports a link to a missing file as unreadable and sends the rest", async () => {
    put("repo/AGENTS.md");
    symlinkSync(at("nowhere.md"), at("repo/broken.md"));
    mocks.parseMarkdownImport.mockResolvedValue({ files: [], records: [], policies: [] });
    const captured = captureWriter();
    await handleSteeringImport([at("repo")], {}, captured.writer);
    expect(sent()[0]?.map((d) => d.filename)).toEqual(["repo/AGENTS.md"]);
    expect(captured.output()).toContain(
      `Skipped files that are empty or unreadable:\n  ${at("repo/broken.md")}`,
    );
  });
});

describe("handleSteeringImport refusals", () => {
  it("refuses an unknown --as before it reads a file (negative)", async () => {
    put("a.md");
    await expect(
      handleSteeringImport([at("a.md")], { as: "skills" }, captureWriter().writer),
    ).rejects.toThrow('Invalid --as "skills". Use records or policies.');
    expect(mocks.parseMarkdownImport).not.toHaveBeenCalled();
  });

  it("refuses --as memories, which is not a target yet (negative)", async () => {
    await expect(
      handleSteeringImport(["a.md"], { as: "memories" }, captureWriter().writer),
    ).rejects.toThrow("Memories are not an import target yet. Use --as records or --as policies.");
  });

  it("fails when the folders hold no Markdown file, and names a missing path (negative)", async () => {
    put("repo/notes.txt");
    const captured = captureWriter();
    await expect(
      handleSteeringImport([at("repo"), at("ghost")], {}, captured.writer),
    ).rejects.toThrow(
      `Found no .md, .markdown, or .mdx file in ${at("repo")}, ${at("ghost")}. Pass a Markdown file, or a folder that holds one.`,
    );
    expect(captured.output()).toContain(
      `Skipped paths that do not exist or cannot be read:\n  ${at("ghost")}`,
    );
    expect(mocks.parseMarkdownImport).not.toHaveBeenCalled();
  });

  it("fails when every file is empty (negative)", async () => {
    put("empty.md", "  \n");
    const captured = captureWriter();
    await expect(handleSteeringImport([at("empty.md")], {}, captured.writer)).rejects.toThrow(
      "No readable, non-empty files to import.",
    );
    expect(captured.output()).toContain("empty.md (empty)");
  });

  it("reaches the handler from the command line with --as", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    await expect(
      buildProgram().parseAsync(["steering", "import", at("a.md"), "--as", "skills"], {
        from: "user",
      }),
    ).rejects.toThrow("process.exit:1");
    expect(mocks.parseMarkdownImport).not.toHaveBeenCalled();
  });

  it("exits 1 on the one-shot path when no path is passed (negative)", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    await expect(handleSteeringImport([], {})).rejects.toThrow("process.exit:1");
  });
});

describe("formatImportPolicies", () => {
  it("says so when there are no policies", () => {
    expect(formatImportPolicies([])).toBe("No policies were proposed.");
  });

  it("counts several policy files", () => {
    const policies = [policy(), policy({ path: "policy/b.cedar", file: "b.md" })];
    expect(formatImportPolicies(policies as unknown as MarkdownImportPolicy[])).toContain(
      "2 proposed policy files.",
    );
  });
});

describe("formatImportPullRequest", () => {
  it("names the records and the policy files the PR holds, and the rows left out", () => {
    const out = formatImportPullRequest({ ...pullRequest(2, 2), skipped: 2 });
    expect(out).toContain("with 2 records and 2 policy files.");
    expect(out).toContain("2 rows were left out.");
  });

  it("names zero records when the PR holds nothing else", () => {
    expect(formatImportPullRequest(pullRequest(0, 0))).toContain("with 0 records.");
  });
});
