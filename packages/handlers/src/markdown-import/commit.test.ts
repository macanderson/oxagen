// commit.test.ts: commit_markdown_import over fake deps, and the steering
// PR it opens checked by the real steering checks on the fixture steering
// repo (packages/oxagen/fixtures/steering-repo/repo).
import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ assertContractRole: vi.fn() }));
vi.mock("../lib/capability-role-guard", () => guard);
// ./opener loads the tools PR opener. Its host and logger stay out of these tests.
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("../context.steering.host", () => ({
  createSteeringHost: vi.fn(() => {
    throw new Error("each test passes its own opener");
  }),
}));
vi.mock("@oxagen/ai", () => ({
  selectModelForOrg: vi.fn(() => {
    throw new Error("commit makes no model call");
  }),
  generateObjectFor: vi.fn(() => {
    throw new Error("commit makes no model call");
  }),
}));

import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { steeringMarkdownImportCommit } from "@oxagen/oxagen/contracts/steering.markdown_import.commit";
import type {
  MarkdownImportMemory,
  MarkdownImportPolicy,
  MarkdownImportRecord,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { fixtureContext, fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import { runChecks } from "@oxagen/steering-check";
import { statementHash } from "../memory/statement";
import type { MemoryDraft } from "../memory/types";
import { branchScopeRefusal } from "../steering-repo/stamp";
import type {
  ToolsPullRequestArgs,
  ToolsPullRequestOpener,
  ToolsPullRequestScope,
} from "../tools.pr.open";
import { createCommitMarkdownImportHandler, importPullRequestBody } from "./commit";
import type { MarkdownImportDeps } from "./deps";
import type { HeldMemories } from "./memories";
import { MARKDOWN_IMPORT_PULL_REQUEST } from "./opener";
import { createParseMarkdownImportHandler } from "./parse";
import { steeringMarkdownImportParse } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import type { SplitModel } from "./split";

const ctx = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  surface: "api",
} as unknown as CapabilityContext;

function row(over: Partial<MarkdownImportRecord> = {}): MarkdownImportRecord {
  return {
    file: "CLAUDE.md",
    line: 3,
    origin: "split",
    lineage: "a-intel.claude.no-force-push",
    label: "No force push",
    statement: "Never force-push a shared branch.",
    kind: "constraint",
    kindReason: "It forbids an action.",
    force: "must",
    forceWords: "Never",
    effect: "forbid",
    tokens: 9,
    duplicate: null,
    conflict: null,
    action: "add",
    frontmatter: null,
    ...over,
  };
}

const POLICY: MarkdownImportPolicy = {
  file: "no-branch-delete.md",
  path: "policy/no-branch-delete.cedar",
  text: '// Agents never delete a branch.\n@id("no-branch-delete")\nforbid (principal, action == Action::"github__delete_branch", resource);\n',
  statements: [{ id: "no-branch-delete", line: 6, effect: "forbid" }],
  issues: [],
  duplicate: null,
  replaces: false,
  action: "add",
};

function memory(over: Partial<MarkdownImportMemory> = {}): MarkdownImportMemory {
  return {
    file: "notes.md",
    line: 4,
    label: "Staging resets nightly",
    statement: "The staging database resets every night.",
    kind: "memory",
    force: "info",
    duplicate: null,
    issue: null,
    action: "add",
    ...over,
  };
}

type Opened = { scope: ToolsPullRequestScope; args: ToolsPullRequestArgs };

/** The memory store's two calls, over the drafts it was given. A dedupe key stored once is not stored again. */
function memoryStore(held: HeldMemories = { waiting: [], rejected: [] }) {
  const stored: MemoryDraft[] = [];
  const store = {
    held: vi.fn(async () => held),
    store: vi.fn(async (_scope: unknown, drafts: MemoryDraft[]) => {
      const written: string[] = [];
      for (const draft of drafts) {
        if (stored.some((m) => m.dedupeKey === draft.dedupeKey)) continue;
        stored.push(draft);
        written.push(draft.dedupeKey);
      }
      return written;
    }),
  };
  return { store, stored };
}

function deps(over: Partial<MarkdownImportDeps> = {}) {
  const opened: Opened[] = [];
  const memories = memoryStore();
  const opener: ToolsPullRequestOpener = {
    open: vi.fn(async (scope: ToolsPullRequestScope, args: ToolsPullRequestArgs) => {
      opened.push({ scope, args });
      return { number: 42, url: "https://github.com/a-intel/steering/pull/42", branch: args.branch, headSha: "head42" };
    }),
  };
  const d: MarkdownImportDeps = {
    names: async () => ({ organization: "a-intel", workspace: "core" }),
    publishedRecords: async () => [],
    publishedPolicies: async () => [],
    split: vi.fn<SplitModel>(),
    branchTaken: async () => false,
    opener,
    memories: memories.store,
    now: () => new Date("2026-09-30T12:00:00Z"),
    ...over,
  };
  return { d, opened, stored: memories.stored };
}

const commit = (d: MarkdownImportDeps, input: unknown) =>
  createCommitMarkdownImportHandler(d)(steeringMarkdownImportCommit.input.parse(input), ctx);

async function reasonOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return isHandlerError(err) ? err.reason : String(err);
  }
}

beforeEach(() => {
  guard.assertContractRole.mockReset();
  guard.assertContractRole.mockResolvedValue(undefined);
});

describe("the contract's rows", () => {
  it("refuses a force the kind forbids, and a constraint with no effect (negative)", () => {
    const parse = (records: MarkdownImportRecord[]) =>
      steeringMarkdownImportCommit.input.safeParse({ records }).success;
    expect(parse([row({ kind: "preference", force: "must", effect: null })])).toBe(false);
    expect(parse([row({ kind: "fact", force: "should", effect: null })])).toBe(false);
    expect(parse([row({ effect: null })])).toBe(false);
    expect(parse([row({ kind: "business-rule", effect: "forbid" })])).toBe(false);
    expect(parse([row({ origin: "frontmatter" })])).toBe(false);
    expect(parse([row()])).toBe(true);
  });
});

describe("commit_markdown_import", () => {
  it("checks the caller's role from the contract", async () => {
    guard.assertContractRole.mockRejectedValue(new Error("forbidden"));
    const { d } = deps();
    await expect(commit(d, { records: [row()] })).rejects.toThrow("forbidden");
    expect(guard.assertContractRole).toHaveBeenCalledWith(steeringMarkdownImportCommit, ctx);
  });

  it("opens one steering PR on steering/import-<date> with every row marked add", async () => {
    const { d, opened } = deps();
    const out = await commit(d, {
      records: [
        row(),
        row({ lineage: "a-intel.claude.prefer-rg", label: "Prefer rg", statement: "Prefer rg over grep.", kind: "preference", force: "may", forceWords: "Prefer", effect: null }),
        row({ lineage: "a-intel.claude.skipped", statement: "Skip me.", action: "skip", kind: "fact", force: "info", effect: null }),
      ],
      policies: [POLICY],
    });
    expect(opened).toHaveLength(1);
    const args = opened[0]?.args as ToolsPullRequestArgs;
    expect(args.branch).toBe("steering/import-2026-09-30");
    expect(args.title).toBe("Import 2 records and 1 policy file from Markdown");
    expect(args.files.map((f) => f.path)).toEqual([
      "policy/no-branch-delete.cedar",
      "steering/constraints/a-intel.claude.no-force-push.md",
      "steering/preferences/a-intel.claude.prefer-rg.md",
    ]);
    expect(out).toEqual({
      pullRequest: {
        number: 42,
        url: "https://github.com/a-intel/steering/pull/42",
        branch: "steering/import-2026-09-30",
        headSha: "head42",
      },
      paths: args.files.map((f) => f.path),
      records: 2,
      policies: 1,
      skipped: 1,
      memories: { stored: 0, skipped: [] },
    });
    // The branch rule the opener applies accepts these files.
    expect(MARKDOWN_IMPORT_PULL_REQUEST.refusal(args)).toBeNull();
    const record = readSteeringRecord(args.files[1]?.content as string);
    expect(record.ok && record.record).toMatchObject({
      origin: "user",
      provenance: { source: "import", uri: "oxagen:import/CLAUDE.md#L3" },
    });
  });

  it("takes the next free branch of the day", async () => {
    const taken = new Set(["steering/import-2026-09-30", "steering/import-2026-09-30-2"]);
    const { d, opened } = deps({ branchTaken: async (_scope, branch) => taken.has(branch) });
    await commit(d, { records: [row()] });
    expect(opened[0]?.args.branch).toBe("steering/import-2026-09-30-3");
  });

  it("gives up when every branch of the day is taken (negative)", async () => {
    const { d, opened } = deps({ branchTaken: async () => true });
    expect(await reasonOf(commit(d, { records: [row()] }))).toBe("import_branches_exhausted");
    expect(opened).toHaveLength(0);
  });

  it("writes a revision where its published record lives", async () => {
    const { d, opened } = deps({
      publishedRecords: async () => [
        {
          lineage: "a-intel.claude.no-force-push",
          kind: "constraint",
          effect: "forbid",
          statement: "Never force-push.",
          path: "steering/platform/a-intel.claude.no-force-push.md",
        },
      ],
    });
    await commit(d, { records: [row()] });
    expect(opened[0]?.args.files.map((f) => f.path)).toEqual([
      "steering/platform/a-intel.claude.no-force-push.md",
    ]);
  });

  it("refuses what the PR cannot hold (negative)", async () => {
    const { d, opened } = deps();
    expect(
      await reasonOf(
        commit(d, {
          records: [row({ action: null, conflict: { lineage: "a-intel.other", path: null, published: true } })],
        }),
      ),
    ).toBe("conflict_unresolved");
    expect(
      await reasonOf(
        commit(d, {
          policies: [{ ...POLICY, issues: [{ statement: 1, id: "x", line: 6, message: "Statement 1 (x) has no semicolon at its end." }] }],
        }),
      ),
    ).toBe("policy_invalid");
    expect(await reasonOf(commit(d, { records: [row({ action: "skip" })] }))).toBe("nothing_to_import");
    expect(await reasonOf(commit(d, { records: [row(), row({ line: 9 })] }))).toBe("duplicate_lineage");
    expect(
      await reasonOf(commit(d, { policies: [POLICY, { ...POLICY, file: "other.md" }] })),
    ).toBe("duplicate_path");
    expect(opened).toHaveLength(0);
  });
});

describe("commit_markdown_import with memories", () => {
  it("refuses a memory over 2,000 characters marked add, and takes one marked skip (negative)", () => {
    const parse = (memories: MarkdownImportMemory[]) =>
      steeringMarkdownImportCommit.input.safeParse({ memories }).success;
    const long = "x".repeat(2001);
    expect(parse([memory({ statement: long })])).toBe(false);
    expect(parse([memory({ statement: long, action: "skip" })])).toBe(true);
    expect(parse([memory({ kind: "fact" as "memory" })])).toBe(false);
    expect(parse([memory({ force: "may" as "info" })])).toBe(false);
    expect(parse([memory()])).toBe(true);
  });

  it("stores each memory marked add as a waiting memory with capture import and opens no PR", async () => {
    const publishedRecords = vi.fn(async () => []);
    const branchTaken = vi.fn(async () => false);
    const { d, opened, stored } = deps({ publishedRecords, branchTaken });
    const out = await commit(d, {
      memories: [
        memory(),
        memory({ line: 5, label: "Use pnpm", statement: "Use pnpm, not npm." }),
        memory({ line: 6, statement: "Left out.", action: "skip" }),
      ],
    });
    expect(out).toEqual({
      pullRequest: null,
      paths: [],
      records: 0,
      policies: 0,
      skipped: 1,
      memories: { stored: 2, skipped: [] },
    });
    // The person who imported the file is the author: no agent and no run.
    expect(stored).toEqual([
      {
        agentLineage: null,
        runPublicId: null,
        capture: "import",
        statement: "The staging database resets every night.",
        statementHash: statementHash("The staging database resets every night."),
        kind: "memory",
        repos: null,
        appliesTo: null,
        tools: null,
        evidence: [],
        source: "import:notes.md#L4",
        dedupeKey: `import:import:notes.md#L4:${statementHash("The staging database resets every night.")}`,
        label: "Staging resets nightly",
      },
      expect.objectContaining({ source: "import:notes.md#L5", label: "Use pnpm", capture: "import" }),
    ]);
    // A memories-only commit reads nothing from the registry or the steering repo.
    expect(opened).toHaveLength(0);
    expect(publishedRecords).not.toHaveBeenCalled();
    expect(branchTaken).not.toHaveBeenCalled();
    expect(steeringMarkdownImportCommit.output.safeParse(out).success).toBe(true);
  });

  it("stores the memories and opens the steering PR for the records in one commit", async () => {
    const { d, opened, stored } = deps();
    const order: string[] = [];
    const store = d.memories.store;
    d.memories.store = vi.fn(async (scope: ToolsPullRequestScope, drafts: MemoryDraft[]) => {
      order.push("memories");
      return store(scope, drafts);
    });
    const open = d.opener.open;
    d.opener.open = vi.fn(async (scope: ToolsPullRequestScope, args: ToolsPullRequestArgs) => {
      order.push("pr");
      return open(scope, args);
    });
    const out = await commit(d, { records: [row()], policies: [POLICY], memories: [memory()] });
    expect(order).toEqual(["memories", "pr"]);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.args.title).toBe("Import 1 record and 1 policy file from Markdown");
    expect(stored).toHaveLength(1);
    expect(out).toMatchObject({
      pullRequest: { number: 42 },
      records: 1,
      policies: 1,
      skipped: 0,
      memories: { stored: 1, skipped: [] },
    });
  });

  it("leaves out a memory a waiting memory, a rejection, or an earlier row holds, and names each one", async () => {
    const held: HeldMemories = {
      waiting: [{ publicId: "mem_01waiting", statementHash: statementHash("The staging database resets every night.") }],
      rejected: [statementHash("Use pnpm, not npm.")],
    };
    const memories = memoryStore(held);
    const { d } = deps({ memories: memories.store });
    const out = await commit(d, {
      memories: [
        memory(),
        memory({ line: 5, statement: "Use pnpm, not npm." }),
        memory({ line: 6, statement: "Run the linter before you push." }),
        memory({ file: "other.md", line: 2, statement: "run the linter before you push" }),
      ],
    });
    expect(out.memories).toEqual({
      stored: 1,
      skipped: [
        { file: "notes.md", line: 4, reason: "waiting", memory: "mem_01waiting" },
        { file: "notes.md", line: 5, reason: "rejected", memory: null },
        { file: "other.md", line: 2, reason: "import", memory: null },
      ],
    });
    expect(memories.stored.map((m) => m.source)).toEqual(["import:notes.md#L6"]);
  });

  it("names a memory an earlier import stored from the same line, whose memory has moved on", async () => {
    const { d } = deps();
    // The first commit stores the memory. The memory then leaves the waiting
    // state, so the second commit's check finds no waiting match, and the
    // store's dedupe key leaves it out.
    await commit(d, { memories: [memory()] });
    const out = await commit(d, { memories: [memory(), memory({ line: 9, statement: "A new lesson." })] });
    expect(out.memories).toEqual({
      stored: 1,
      skipped: [{ file: "notes.md", line: 4, reason: "stored", memory: null }],
    });
  });

  it("refuses everything before it stores a memory (negative)", async () => {
    const { d, stored } = deps();
    expect(
      await reasonOf(
        commit(d, {
          records: [row({ action: null, conflict: { lineage: "a-intel.other", path: null, published: true } })],
          memories: [memory()],
        }),
      ),
    ).toBe("conflict_unresolved");
    const exhausted = deps({ branchTaken: async () => true });
    expect(await reasonOf(commit(exhausted.d, { records: [row()], memories: [memory()] }))).toBe(
      "import_branches_exhausted",
    );
    expect(await reasonOf(commit(d, { memories: [memory({ action: "skip" })] }))).toBe("nothing_to_import");
    expect(stored).toHaveLength(0);
    expect(exhausted.stored).toHaveLength(0);
  });
});

describe("importPullRequestBody", () => {
  it("lists each record and policy with its source, and the rows left out", () => {
    const body = importPullRequestBody({
      records: [{ row: row(), path: "steering/constraints/a-intel.claude.no-force-push.md" }],
      policies: [{ ...POLICY, replaces: true }],
      skipped: 2,
    });
    expect(body).toContain("| `steering/constraints/a-intel.claude.no-force-push.md` | constraint (forbid) | must | CLAUDE.md line 3 |");
    expect(body).toContain("| `policy/no-branch-delete.cedar` | `no-branch-delete` | no-branch-delete.md. Replaces the file at this path. |");
    expect(body).toContain("2 rows were marked skip and left out.");
    expect(body).toContain("`provenance.source: import`");
  });
});

describe("a fixture import", () => {
  const CLAUDE_MD = [
    "# Rules",
    "",
    "- Never force-push a shared branch.",
    "- Prefer short commit subjects.",
    "- The staging database resets every night.",
  ].join("\n");

  const POLICY_MD = [
    "# No branch delete",
    "",
    "Agents never delete a branch.",
    "",
    "```cedar",
    'forbid (principal, action == Action::"github__delete_branch", resource);',
    "```",
  ].join("\n");

  it("parses, commits, and passes the Oxagen steering check on the fixture steering repo", async () => {
    const split = vi.fn<SplitModel>().mockResolvedValue({
      statements: [
        {
          statement: "Never force-push a shared branch.",
          label: "No force push",
          line: 3,
          kind: "constraint",
          kindReason: "It forbids an action.",
          force: "must",
          forceWords: "Never",
          effect: "forbid",
        },
        {
          statement: "Prefer short commit subjects.",
          label: "Short commit subjects",
          line: 4,
          kind: "preference",
          kindReason: "It states a style preference.",
          force: "may",
          forceWords: "Prefer",
          effect: null,
        },
        {
          statement: "The staging database resets every night.",
          label: "Staging resets nightly",
          line: 5,
          kind: "fact",
          kindReason: "It says how the work is.",
          force: "info",
          forceWords: "",
          effect: null,
        },
      ],
    });
    const { d, opened } = deps({ split });
    const parsed = await createParseMarkdownImportHandler(d)(
      steeringMarkdownImportParse.input.parse({
        documents: [
          { filename: "CLAUDE.md", content: CLAUDE_MD },
          { filename: "no-branch-delete.md", content: POLICY_MD },
        ],
      }),
      ctx,
    );
    await commit(d, { records: parsed.records, policies: parsed.policies });
    const args = opened[0]?.args as ToolsPullRequestArgs;

    // The stamp and the merge queue apply the same branch rule.
    expect(branchScopeRefusal(args.branch, args.files.map((f) => f.path))).toBeNull();

    const base = fixtureRepo();
    const head = new Map(base);
    for (const file of args.files) head.set(file.path, file.content as string);
    const { runtimes, members, teams, groups, credentials } = fixtureContext();
    const report = runChecks({
      files: head,
      base,
      index: null,
      context: { runtimes, members, teams, groups, credentials },
      health: null,
    });
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
