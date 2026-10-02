/**
 * `oxagen memory` handlers: pins the wire contract of list, show, promote,
 * and dismiss through the apiPostOrThrow seam (the exact route and body,
 * with the server's defaults left to the server), the argument checks that
 * refuse before any request leaves the process, the human and JSON output
 * written through the CommandWriter, and the one-shot path's stderr and
 * exit(1) contract. The import tests read files through a mocked readFile.
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
import {
  handleMemoryDismiss,
  handleMemoryImport,
  handleMemoryList,
  handleMemoryPromote,
  handleMemoryShow,
  MEMORY_COMMAND_CAPABILITIES,
} from "./memory";

/** A Claude Code memory file's memory, as list_workspace_memories answers it. */
function memory(over: Record<string, unknown> = {}) {
  return {
    id: "mem_0a1b2c",
    label: "Use pnpm",
    summary: "The repo installs with pnpm.",
    statement: "Use pnpm, never npm, in this repository.",
    state: "waiting",
    capture: "local_gateway",
    harness: "claude-code",
    agent: "agt.laptop",
    source: "claude-code:/home/dev/.claude/projects/-proj/memory/use-pnpm.md",
    repos: null,
    memory_type: "feedback",
    kind: "memory",
    use_count: 3,
    use_signal: true,
    last_used_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    created_at: "2026-09-30T10:00:00.000Z",
    promoted_lineage: null,
    memory_pr: null,
    ...over,
  };
}

function listResult(groups: ReturnType<typeof memory>[][], over = {}) {
  return {
    groups: groups.map((members) => ({
      memory: members[0],
      members,
      use_count: members.reduce((sum, m) => sum + (m.use_count as number), 0),
      last_used_at: members[0]?.last_used_at ?? null,
    })),
    total_groups: groups.length,
    total_memories: groups.flat().length,
    truncated: false,
    waiting: groups.flat().length,
    ...over,
  };
}

describe("the capabilities the commands name", () => {
  it("names the four workspace memory capabilities by their registered names", () => {
    expect(MEMORY_COMMAND_CAPABILITIES).toEqual([
      "list_workspace_memories",
      "get_workspace_memory",
      "promote_memories",
      "dismiss_memories",
    ]);
  });
});

describe("memory list", () => {
  it("sends only the filters given, so the server's defaults apply", async () => {
    apiPostOrThrow.mockResolvedValue(listResult([]));
    const captured = captureWriter();
    await handleMemoryList({}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/memories/list",
      {},
    );
    expect(captured.output()).toBe(
      "No memories yet. Oxagen collects them from enrolled hosts every five minutes.",
    );
  });

  it("maps every filter onto the body, with states split on commas and numbers parsed", async () => {
    apiPostOrThrow.mockResolvedValue(listResult([]));
    await handleMemoryList(
      {
        state: "waiting,promoted",
        harness: "codex",
        agent: "agt.laptop",
        repository: "github.com/acme/api",
        type: "feedback",
        limit: "10",
        offset: "20",
      },
      captureWriter().writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/memories/list",
      {
        states: ["waiting", "promoted"],
        harness: "codex",
        agent: "agt.laptop",
        repository: "github.com/acme/api",
        type: "feedback",
        limit: 10,
        offset: 20,
      },
    );
  });

  it("prints one row per group, ranked as the server sent them, with same-text counts", async () => {
    const first = memory();
    const twin = memory({ id: "mem_3d4e5f", use_count: 1 });
    const codex = memory({
      id: "mem_6g7h8j",
      label: null,
      statement: "Run the migration check\nbefore the build.",
      harness: "codex",
      use_count: 0,
      last_used_at: null,
      state: "in_pr",
    });
    apiPostOrThrow.mockResolvedValue(listResult([[first, twin], [codex]], { waiting: 5 }));
    const captured = captureWriter();
    await handleMemoryList({}, captured.writer);
    const lines = captured.output().split("\n");
    expect(lines[0]).toMatch(/^ID\s+Uses\s+Last used\s+Harness\s+State\s+Memory$/);
    expect(lines[1]).toMatch(/^mem_0a1b2c\s+4\s+3h ago\s+claude-code\s+Waiting\s+Use pnpm \(\+1 same\)$/);
    expect(lines[2]).toMatch(/^mem_6g7h8j\s+0\s+Never\s+codex\s+In PR\s+Run the migration check$/);
    expect(lines).toContain("2 groups.");
    expect(lines).toContain("5 memories wait in this workspace.");
  });

  it("shows No signal for a harness that reports no uses", async () => {
    apiPostOrThrow.mockResolvedValue(
      listResult([[memory({ harness: null, capture: "remember", use_count: 0, use_signal: false })]]),
    );
    const captured = captureWriter();
    await handleMemoryList({}, captured.writer);
    expect(captured.output().split("\n")[1]).toMatch(/^mem_0a1b2c\s+No signal\s+/);
  });

  it("says how to page, and when the list grouped only the top memories", async () => {
    apiPostOrThrow.mockResolvedValue(
      listResult([[memory()]], { total_groups: 3, total_memories: 2000, truncated: true }),
    );
    const captured = captureWriter();
    await handleMemoryList({ limit: "1" }, captured.writer);
    const out = captured.output();
    expect(out).toContain("Showing 1 of 3 groups. Use --limit and --offset to page.");
    expect(out).toContain(
      "More than 2000 memories matched, and the list groups the top 2000. Narrow the filters to see the rest.",
    );
  });

  it("refuses an unknown state before any request", async () => {
    const captured = captureWriter();
    await expect(
      handleMemoryList({ state: "waiting,archived" }, captured.writer),
    ).rejects.toThrow(
      'Invalid --state "archived". Use one of: waiting, in_pr, promoted, dismissed, retired.',
    );
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("refuses an unknown harness before any request", async () => {
    await expect(
      handleMemoryList({ harness: "gemini" }, captureWriter().writer),
    ).rejects.toThrow('Invalid --harness "gemini".');
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("--json writes the raw result", async () => {
    const result = listResult([[memory()]]);
    apiPostOrThrow.mockResolvedValue(result);
    const captured = captureWriter();
    await handleMemoryList({ json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual(result);
  });

  it("writes the API's message and fails when the call is refused", async () => {
    apiPostOrThrow.mockRejectedValue(new MockApiError("Forbidden", 403));
    const captured = captureWriter();
    await expect(handleMemoryList({}, captured.writer)).rejects.toThrow("Forbidden");
    expect(captured.output()).toBe("Forbidden");
  });
});

describe("memory show", () => {
  const shown = {
    memory: {
      ...memory({ state: "in_pr", memory_pr: { number: 7, url: "https://github.com/acme/steering/pull/7", status: "open" } }),
      run: null,
      evidence: [],
      applies_to: null,
      tools: null,
      retired_at: null,
      retired_reason: null,
    },
    uses: [
      { run: "tse_a1b2c3", signal: "read", count: 2, used_at: "2026-10-01T10:00:00.000Z" },
    ],
    uses_total: 4,
    memory_pr: {
      id: "mpr_0a1b2c",
      number: 7,
      url: "https://github.com/acme/steering/pull/7",
      repository: "acme/steering",
      branch: "memory/2026-10-01",
      status: "open",
      opened_at: "2026-10-01T09:00:00.000Z",
      settled_at: null,
    },
  };

  it("reads the memory by id and prints its text, source, uses, and memory PR", async () => {
    apiPostOrThrow.mockResolvedValue(shown);
    const captured = captureWriter();
    await handleMemoryShow("mem_0a1b2c", {}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/memories/get",
      { memory_id: "mem_0a1b2c" },
    );
    const out = captured.output();
    expect(out).toContain("Memory mem_0a1b2c");
    expect(out).toContain("  State:      In PR");
    expect(out).toContain(`  Source:     ${shown.memory.source}`);
    expect(out).toContain("  Memory PR:  #7 (open) https://github.com/acme/steering/pull/7");
    expect(out).toContain("Use pnpm, never npm, in this repository.");
    expect(out).toContain("Uses (1 of 4):");
    expect(out).toContain("  2026-10-01T10:00:00.000Z  read  tse_a1b2c3  x2");
  });

  it("--json writes the raw result", async () => {
    apiPostOrThrow.mockResolvedValue(shown);
    const captured = captureWriter();
    await handleMemoryShow("mem_0a1b2c", { json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual(shown);
  });

  it("fails with the API's message for a memory the workspace does not hold", async () => {
    apiPostOrThrow.mockRejectedValue(
      new MockApiError("This workspace holds no memory mem_zz.", 404),
    );
    const captured = captureWriter();
    await expect(handleMemoryShow("mem_zz", {}, captured.writer)).rejects.toThrow(
      "This workspace holds no memory mem_zz.",
    );
  });
});

describe("memory promote", () => {
  const opened = {
    pull_request: {
      number: 7,
      url: "https://github.com/acme/steering/pull/7",
      branch: "memory/2026-10-01",
      opened: true,
    },
    records: [
      {
        path: "steering/memory/workspace/general/pnpm-never-npm-repository.md",
        lineage: "pnpm-never-npm-repository",
        kind: "code-rule",
        force: "should",
        effect: null,
        memory_ids: ["mem_0a1b2c", "mem_3d4e5f"],
      },
    ],
    skipped: [{ memory_id: "mem_9z8y7x", reason: "not_waiting" }],
  };

  it("sends one draft per id, citing same-text memories, by default", async () => {
    apiPostOrThrow.mockResolvedValue(opened);
    await handleMemoryPromote(["mem_0a1b2c", "mem_9z8y7x"], {}, captureWriter().writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/memories/promote",
      {
        drafts: [{ memory_ids: ["mem_0a1b2c"] }, { memory_ids: ["mem_9z8y7x"] }],
        same_text: true,
      },
    );
  });

  it("sends one draft citing every id with --one-record, with the kind, force, statement, and repos", async () => {
    apiPostOrThrow.mockResolvedValue(opened);
    await handleMemoryPromote(
      ["mem_0a1b2c", "mem_3d4e5f"],
      {
        oneRecord: true,
        statement: "Install with pnpm.",
        kind: "code-rule",
        force: "must",
        repo: ["github.com/acme/api,github.com/acme/web"],
        sameText: false,
      },
      captureWriter().writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/memories/promote",
      {
        drafts: [
          {
            memory_ids: ["mem_0a1b2c", "mem_3d4e5f"],
            statement: "Install with pnpm.",
            kind: "code-rule",
            force: "must",
            repos: ["github.com/acme/api", "github.com/acme/web"],
          },
        ],
        same_text: false,
      },
    );
  });

  it("prints the memory PR, each record, and each memory it left out", async () => {
    apiPostOrThrow.mockResolvedValue(opened);
    const captured = captureWriter();
    await handleMemoryPromote(["mem_0a1b2c"], {}, captured.writer);
    expect(captured.output()).toBe(
      [
        "Opened memory PR #7 on memory/2026-10-01: https://github.com/acme/steering/pull/7",
        "  steering/memory/workspace/general/pnpm-never-npm-repository.md (code-rule, should) cites mem_0a1b2c, mem_3d4e5f",
        "Nothing steers until a person merges the PR.",
        "Skipped mem_9z8y7x: the memory is not waiting.",
      ].join("\n"),
    );
  });

  it("says so when no memory could be promoted", async () => {
    apiPostOrThrow.mockResolvedValue({
      pull_request: null,
      records: [],
      skipped: [{ memory_id: "mem_9z8y7x", reason: "already_proposed" }],
    });
    const captured = captureWriter();
    await handleMemoryPromote(["mem_9z8y7x"], {}, captured.writer);
    expect(captured.output()).toBe(
      [
        "No record was added, because no memory you named can be promoted.",
        "Skipped mem_9z8y7x: an open memory PR already proposes its statement.",
      ].join("\n"),
    );
  });

  it("refuses --statement for more than one record before any request", async () => {
    await expect(
      handleMemoryPromote(
        ["mem_0a1b2c", "mem_3d4e5f"],
        { statement: "Install with pnpm." },
        captureWriter().writer,
      ),
    ).rejects.toThrow("--statement sets one record's body.");
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind, force, or effect before any request", async () => {
    await expect(
      handleMemoryPromote(["mem_0a1b2c"], { kind: "skill" }, captureWriter().writer),
    ).rejects.toThrow('Invalid --kind "skill".');
    await expect(
      handleMemoryPromote(["mem_0a1b2c"], { force: "always" }, captureWriter().writer),
    ).rejects.toThrow('Invalid --force "always".');
    await expect(
      handleMemoryPromote(["mem_0a1b2c"], { effect: "allow" }, captureWriter().writer),
    ).rejects.toThrow('Invalid --effect "allow".');
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });
});

describe("memory dismiss", () => {
  it("dismisses the ids and says the curator holds their statements", async () => {
    apiPostOrThrow.mockResolvedValue({
      changed: ["mem_0a1b2c"],
      skipped: [{ memory_id: "mem_9z8y7x", state: "promoted" }],
      rejections: 1,
    });
    const captured = captureWriter();
    await handleMemoryDismiss(["mem_0a1b2c", "mem_9z8y7x"], {}, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/memories/dismiss",
      { memory_ids: ["mem_0a1b2c", "mem_9z8y7x"], restore: false },
    );
    expect(captured.output()).toBe(
      [
        "Dismissed 1 memory: mem_0a1b2c.",
        "The curator proposes their statements again only after memories from 2 more runs repeat them.",
        "Skipped mem_9z8y7x: a steering record carries it.",
      ].join("\n"),
    );
  });

  it("restores with --restore", async () => {
    apiPostOrThrow.mockResolvedValue({
      changed: [],
      skipped: [{ memory_id: "mem_0a1b2c", state: "waiting" }, { memory_id: "mem_zz", state: null }],
      rejections: 0,
    });
    const captured = captureWriter();
    await handleMemoryDismiss(["mem_0a1b2c", "mem_zz"], { restore: true }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/memories/dismiss",
      { memory_ids: ["mem_0a1b2c", "mem_zz"], restore: true },
    );
    expect(captured.output()).toBe(
      [
        "No memory was restored.",
        "Skipped mem_0a1b2c: it is waiting.",
        "Skipped mem_zz: this workspace holds no such memory.",
      ].join("\n"),
    );
  });

  it("--json writes the raw result", async () => {
    const result = { changed: ["mem_0a1b2c"], skipped: [], rejections: 1 };
    apiPostOrThrow.mockResolvedValue(result);
    const captured = captureWriter();
    await handleMemoryDismiss(["mem_0a1b2c"], { json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual(result);
  });
});

const draft = {
  lesson: "Prefer rg over grep",
  memoryClass: "RULE",
  memoryKind: "gotcha",
  enforcementScore: 60,
  source: "import",
  nodeRef: "app:web",
  sourceDocument: "rules.md",
  classified: true,
};
const draft2 = { ...draft, lesson: "Pin toolchain versions" };

describe("memory import", () => {
  it("refuses an empty file list", async () => {
    const captured = captureWriter();
    await expect(handleMemoryImport([], {}, captured.writer)).rejects.toThrow(
      "Nothing to import. Pass one or more markdown files, e.g. `oxagen memory import rules.md`.",
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
    ).rejects.toThrow("No readable, non-empty documents to import.");
    const out = captured.output();
    expect(out).toContain("⚠ Skipped unreadable/empty files:");
    expect(out).toContain("bad.md");
    expect(out).toContain("empty.md (empty)");
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("previews drafts without --yes — parse only, basename'd filenames, skipped files, rerun hint", async () => {
    readFile.mockResolvedValue("# rules\n- do x\n");
    apiPostOrThrow.mockResolvedValue({
      drafts: [draft],
      documentCount: 1,
      skipped: [{ filename: "notes.md", reason: "no content" }],
    });
    const captured = captureWriter();
    await handleMemoryImport(
      ["docs/rules.md"],
      { node: "app:web" },
      captured.writer,
    );
    expect(readFile).toHaveBeenCalledWith("docs/rules.md", "utf8");
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
    expect(apiPostOrThrow).toHaveBeenCalledWith("agent/memory/import/parse", {
      documents: [{ filename: "rules.md", content: "# rules\n- do x\n" }],
      defaultNodeRef: "app:web",
    });
    const out = captured.output();
    expect(out).toContain("Prefer rg over grep");
    expect(out).toContain("1 draft memory.");
    expect(out).toContain("· skipped notes.md: no content");
    expect(out).toContain("Re-run with --yes to import these memories.");
  });

  it("preview of zero drafts prints the empty message and no rerun hint", async () => {
    readFile.mockResolvedValue("# empty of rules\n");
    apiPostOrThrow.mockResolvedValue({
      drafts: [],
      documentCount: 1,
      skipped: [],
    });
    const captured = captureWriter();
    await handleMemoryImport(["rules.md"], {}, captured.writer);
    expect(captured.output()).toBe("No memories could be extracted.");
  });

  it("--json preview emits the parse output and never commits", async () => {
    readFile.mockResolvedValue("# rules\n");
    const parsed = { drafts: [draft], documentCount: 1, skipped: [] };
    apiPostOrThrow.mockResolvedValue(parsed);
    const captured = captureWriter();
    await handleMemoryImport(["rules.md"], { json: true }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured.output())).toEqual(parsed);
  });

  it("--yes with zero extractable drafts fails instead of committing", async () => {
    readFile.mockResolvedValue("# rules\n");
    apiPostOrThrow.mockResolvedValue({
      drafts: [],
      documentCount: 1,
      skipped: [],
    });
    const captured = captureWriter();
    await expect(
      handleMemoryImport(["rules.md"], { yes: true }, captured.writer),
    ).rejects.toThrow(
      "No memories could be extracted from the supplied documents.",
    );
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
  });

  it("--yes commits the parsed drafts and prints the summary with per-row errors", async () => {
    readFile.mockResolvedValue("# rules\n");
    apiPostOrThrow.mockImplementation(async (path) =>
      path === "agent/memory/import/parse"
        ? { drafts: [draft, draft2], documentCount: 1, skipped: [] }
        : {
            results: [
              {
                lesson: draft.lesson,
                ok: true,
                memoryId: "mem_9",
                error: null,
              },
              {
                lesson: draft2.lesson,
                ok: false,
                memoryId: null,
                error: "duplicate",
              },
            ],
            imported: 1,
            failed: 1,
          },
    );
    const captured = captureWriter();
    await handleMemoryImport(["rules.md"], { yes: true }, captured.writer);
    expect(apiPostOrThrow).toHaveBeenNthCalledWith(
      1,
      "agent/memory/import/parse",
      {
        documents: [{ filename: "rules.md", content: "# rules\n" }],
      },
    );
    expect(apiPostOrThrow).toHaveBeenNthCalledWith(
      2,
      "agent/memory/import/commit",
      {
        drafts: [draft, draft2],
      },
    );
    expect(captured.output()).toBe(
      "✓ Imported 1 memory, 1 failed.\n  ✗ Pin toolchain versions: duplicate",
    );
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
      await expect(handleMemoryPromote([], {})).rejects.toThrow(
        "process.exit(1)",
      );
      expect(exit).toHaveBeenCalledWith(1);
      expect(errWrite).toHaveBeenCalledWith(
        "Nothing to promote. Pass one or more memory ids, such as `oxagen memory promote mem_…`.\n",
      );
    } finally {
      exit.mockRestore();
      errWrite.mockRestore();
    }
  });
});
