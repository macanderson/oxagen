// promote.ts end to end over fakes (memory-collection spec, Promotion;
// #4912). The steering repo is the fixture repo on FakeGitHub, and the two
// memory stores keep their rows in memory. Each case checks what reaches the
// host: the branch, the commit and its files, the PR and its body, and what
// the memory PR row and the memories hold afterwards.
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import { describe, expect, it } from "vitest";
import { FakeGitHub, REPO } from "../context.steering.test-support";
import { memoryLineage, memoryRecordPath } from "./naming";
import { promoteMemories, type PromoteDeps } from "./promote";
import { statementHash } from "./statement";
import type { MemoryPrRecord, MemoryScope, OpenMemoryPr } from "./types";
import type { WorkspaceMemoryRow } from "./workspace-store";

const SCOPE: MemoryScope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const NOW = new Date("2026-10-01T15:00:00.000Z");
const TODAY = "memory/2026-10-01";
const STATEMENT = "Use pnpm, never npm, in this repository.";

let n = 0;
function memory(
  statement: string,
  over: Partial<WorkspaceMemoryRow> = {},
): WorkspaceMemoryRow {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id,
    publicId: `mem_${n}`,
    agentLineage: "agt.laptop",
    runPublicId: null,
    capture: "local_gateway",
    statement,
    statementHash: statementHash(statement),
    kind: "memory",
    repos: null,
    appliesTo: null,
    tools: null,
    evidence: [],
    source: `claude-code:/home/dev/.claude/projects/-p/memory/m${n}.md`,
    label: null,
    summary: null,
    memoryType: "feedback",
    state: "waiting",
    useCount: 1,
    lastUsedAt: new Date("2026-10-01T10:00:00.000Z"),
    promotedLineage: null,
    retiredAt: null,
    retiredReason: null,
    createdAt: new Date("2026-09-30T10:00:00.000Z"),
    memoryPr: null,
    ...over,
  };
}

type StoredPr = OpenMemoryPr & { status: "open" | "merged" | "closed" };

/** The two memory stores, in memory. */
class FakeStores {
  memories: WorkspaceMemoryRow[] = [];
  prs: StoredPr[] = [];
  /** Branches a memory PR was opened from, settled or not. */
  usedBranches = new Set<string>();

  store: PromoteDeps["store"] = {
    listOpenPrs: async () => this.prs.filter((pr) => pr.status === "open"),
    openedPrFrom: async (_scope, branch) =>
      this.usedBranches.has(branch) || this.prs.some((pr) => pr.branch === branch),
    insertMemoryPr: async (_scope, pr) => {
      const id = `00000000-0000-4000-9000-${String(this.prs.length + 1).padStart(12, "0")}`;
      this.prs.push({ ...pr, id, openedAt: NOW, status: "open" });
      const cited = new Set(pr.records.flatMap((r) => r.memoryIds));
      for (const m of this.memories)
        if (cited.has(m.id)) Object.assign(m, { state: "in_pr" });
      return id;
    },
  };

  workspace: PromoteDeps["workspace"] = {
    findMemories: async (_scope, ids) => {
      const wanted = new Set(ids.map((id) => id.toLowerCase()));
      return this.memories.filter((m) => wanted.has(m.publicId.toLowerCase()));
    },
    listMemories: async (_scope, filter, max) => {
      const time = (d: Date | null) => (d === null ? -Infinity : d.getTime());
      const rows = this.memories
        .filter((m) => filter.states.includes(m.state))
        .sort(
          (a, b) =>
            b.useCount - a.useCount ||
            time(b.lastUsedAt) - time(a.lastUsedAt) ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? -1 : 1),
        );
      return { rows: rows.slice(0, max), total: rows.length };
    },
    appendMemoryPrRecords: async (_scope, prId, records) => {
      const pr = this.prs.find((p) => p.id === prId && p.status === "open");
      if (pr === undefined) return false;
      pr.records = [...pr.records, ...records];
      const cited = new Set(records.flatMap((r) => r.memoryIds));
      for (const m of this.memories)
        if (cited.has(m.id) && m.state === "waiting") Object.assign(m, { state: "in_pr" });
      return true;
    },
  };
}

/** The fixture steering repo on main, plus any `main:<path>` files given. */
function steeringRepo(extra: Record<string, string> = {}): FakeGitHub {
  const seed: Record<string, string> = {};
  for (const [path, text] of fixtureRepo()) seed[`main:${path}`] = text;
  return new FakeGitHub({ ...seed, ...extra });
}

function harness(gh: FakeGitHub = steeringRepo()) {
  const fakes = new FakeStores();
  const deps: PromoteDeps = {
    host: gh,
    store: fakes.store,
    workspace: fakes.workspace,
    now: () => NOW,
  };
  return { gh, fakes, deps };
}

/** The file a stamp wrote at `path`. */
function fileAt(gh: FakeGitHub, path: string): string {
  const file = gh.stamps.flatMap((s) => s.files).find((f) => f.path === path);
  if (file?.content == null) throw new Error(`no file at ${path}`);
  return file.content;
}

const plannedPath = (statement: string) =>
  memoryRecordPath(null, null, null, memoryLineage(statement, new Set()));

describe("promoteMemories opening a memory PR", () => {
  it("opens today's memory PR with one record that cites its memory", async () => {
    const { gh, fakes, deps } = harness();
    const m = memory(STATEMENT, { runPublicId: "tse_a1b2c3", evidence: ["frame:tse_a1b2c3/4"] });
    fakes.memories.push(m);

    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [m.publicId] }],
      sameText: true,
    });

    const path = plannedPath(STATEMENT);
    const lineage = memoryLineage(STATEMENT, new Set());
    expect(result).toEqual({
      pullRequest: {
        number: gh.pulls[0]?.number,
        url: `https://github.com/a-intel/platform/pull/${gh.pulls[0]?.number}`,
        branch: TODAY,
        opened: true,
      },
      records: [
        { path, lineage, kind: "memory", force: "info", effect: null, memoryIds: [m.publicId] },
      ],
      skipped: [],
    });
    expect(gh.pulls[0]).toMatchObject({
      title: "Memory PR 2026-10-01",
      head: TODAY,
      base: REPO.defaultBranch,
      labels: OXAGEN_PR_LABELS,
    });
    expect(gh.pulls[0]?.body).toContain(
      `- \`${path}\`, a memory with force info. It cites 1 memory from 1 run.`,
    );
    expect(gh.pulls[0]?.body).toContain(`  > ${STATEMENT}`);
    expect(gh.stamps).toHaveLength(1);
    expect(gh.stamps[0]).toMatchObject({ branch: TODAY, parent: "base0" });

    const read = readSteeringRecord(fileAt(gh, path));
    if (!read.ok) throw new Error("the record does not read");
    expect(read.record).toMatchObject({
      lineage,
      kind: "memory",
      force: "info",
      scope: "workspace",
      status: "active",
      origin: "user",
      provenance: {
        source: "run",
        uri: "oxagen:run/tse_a1b2c3",
        memories: [
          { agent: "agt.laptop", run: "tse_a1b2c3", statement: STATEMENT, evidence: ["frame:tse_a1b2c3/4"] },
        ],
      },
    });

    expect(fakes.prs).toHaveLength(1);
    expect(fakes.prs[0]?.records).toEqual([
      {
        action: "propose",
        lineage,
        path,
        kind: "memory",
        memoryIds: [m.id],
        statementHashes: [m.statementHash],
      },
    ]);
    expect(m.state).toBe("in_pr");
  });

  it("writes the person's kind, force, effect, statement, and repositories", async () => {
    const { gh, fakes, deps } = harness();
    const m = memory("The billing tables are migration-free.");
    fakes.memories.push(m);
    const statement = "Never write to the billing tables from a migration.";

    const result = await promoteMemories(deps, SCOPE, {
      drafts: [
        {
          memory_ids: [m.publicId],
          statement,
          kind: "constraint",
          force: "must",
          effect: "forbid",
          repos: ["github.com/acme/api"],
        },
      ],
      sameText: true,
    });

    const lineage = memoryLineage(statement, new Set());
    const path = memoryRecordPath(["github.com/acme/api"], null, null, lineage);
    expect(result.records).toEqual([
      { path, lineage, kind: "constraint", force: "must", effect: "forbid", memoryIds: [m.publicId] },
    ]);
    const read = readSteeringRecord(fileAt(gh, path));
    if (!read.ok) throw new Error("the record does not read");
    expect(read.record).toMatchObject({
      kind: "constraint",
      force: "must",
      effect: "forbid",
      scope: "repository",
      repos: ["github.com/acme/api"],
      provenance: { uri: m.source },
    });
    expect(read.body.trim()).toBe(statement);
  });

  it("keeps a code rule a code rule and gives it force should when the person names no force", async () => {
    const { fakes, deps } = harness();
    const m = memory("Run the migration check before the build.", { kind: "code-rule" });
    fakes.memories.push(m);
    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [m.publicId] }],
      sameText: true,
    });
    expect(result.records[0]).toMatchObject({ kind: "code-rule", force: "should" });
  });

  it("names a new lineage when the planned path already holds a file", async () => {
    const taken = plannedPath(STATEMENT);
    const { gh, fakes, deps } = harness(steeringRepo({ [`main:${taken}`]: "not a record" }));
    const m = memory(STATEMENT);
    fakes.memories.push(m);
    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [m.publicId] }],
      sameText: true,
    });
    expect(result.records[0]?.path).not.toBe(taken);
    expect(result.records[0]?.lineage).toMatch(/-2$/);
    expect(gh.stamps[0]?.files.map((f) => f.path)).toEqual([result.records[0]?.path]);
  });

  it("opens the next memory branch of the day when today's already had a PR", async () => {
    const { gh, fakes, deps } = harness();
    fakes.usedBranches.add(TODAY);
    const m = memory(STATEMENT);
    fakes.memories.push(m);
    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [m.publicId] }],
      sameText: true,
    });
    expect(result.pullRequest?.branch).toBe(`${TODAY}-2`);
    expect(gh.pulls[0]).toMatchObject({ head: `${TODAY}-2`, title: "Memory PR 2026-10-01-2" });
  });
});

describe("promoteMemories joining an open memory PR", () => {
  /** An open memory PR on the host and in the store, with one curator record. */
  async function openPr(gh: FakeGitHub, fakes: FakeStores, cited: WorkspaceMemoryRow) {
    const branch = "memory/2026-09-30";
    await gh.ensureBranch(REPO, branch, REPO.defaultBranch);
    const curated: MemoryPrRecord = {
      action: "propose",
      lineage: "ci-cache-key",
      path: "steering/memory/workspace/general/ci-cache-key.md",
      kind: "memory",
      memoryIds: [cited.id],
      statementHashes: [cited.statementHash],
    };
    gh.commit(branch, curated.path, "curated record");
    const pr = await gh.openPullRequest(REPO, {
      title: "Memory PR 2026-09-30",
      head: branch,
      base: REPO.defaultBranch,
      body: "Oxagen's memory curator opened this PR.",
    });
    fakes.prs.push({
      id: "00000000-0000-4000-9000-0000000000aa",
      provider: REPO.provider,
      repository: REPO.fullName,
      branch,
      number: pr.number,
      url: pr.htmlUrl,
      records: [curated],
      openedAt: new Date("2026-09-30T00:05:00.000Z"),
      status: "open",
    });
    return { branch, pr };
  }

  it("adds the drafts to the open PR's branch and lists them in its body", async () => {
    const { gh, fakes, deps } = harness();
    const curated = memory("Key the CI cache on the lockfile.", { state: "in_pr" });
    const m = memory(STATEMENT);
    fakes.memories.push(curated, m);
    const { branch, pr } = await openPr(gh, fakes, curated);
    const head = gh.heads.get(branch);

    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [m.publicId] }],
      sameText: true,
    });

    expect(result.pullRequest).toEqual({
      number: pr.number,
      url: pr.htmlUrl,
      branch,
      opened: false,
    });
    expect(gh.pulls).toHaveLength(1);
    expect(gh.stamps).toEqual([
      expect.objectContaining({ branch, parent: head, message: "Promote 1 memory record" }),
    ]);
    const body = gh.pulls[0]?.body ?? "";
    expect(body.startsWith("Oxagen's memory curator opened this PR.")).toBe(true);
    expect(body).toContain("## Promoted records");
    expect(body).toContain(`  > ${STATEMENT}`);
    expect(fakes.prs[0]?.records.map((r) => r.lineage)).toEqual([
      "ci-cache-key",
      memoryLineage(STATEMENT, new Set()),
    ]);
    expect(m.state).toBe("in_pr");
  });

  it("skips a memory whose statement the open PR already proposes", async () => {
    const { gh, fakes, deps } = harness();
    const curated = memory(STATEMENT, { state: "in_pr" });
    const copy = memory(STATEMENT);
    fakes.memories.push(curated, copy);
    await openPr(gh, fakes, curated);

    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [copy.publicId] }],
      sameText: true,
    });

    expect(result).toEqual({
      pullRequest: null,
      records: [],
      skipped: [{ memoryId: copy.publicId, reason: "already_proposed" }],
    });
    expect(gh.stamps).toEqual([]);
  });

  it("opens a new PR when the open one was closed on the host", async () => {
    const { gh, fakes, deps } = harness();
    const curated = memory("Key the CI cache on the lockfile.", { state: "in_pr" });
    const m = memory(STATEMENT);
    fakes.memories.push(curated, m);
    const { pr } = await openPr(gh, fakes, curated);
    gh.closeOnHost(pr.number);

    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [m.publicId] }],
      sameText: true,
    });

    expect(result.pullRequest).toMatchObject({ branch: TODAY, opened: true });
    expect(fakes.prs).toHaveLength(2);
  });
});

describe("promoteMemories choosing the memories", () => {
  it("cites the waiting memories that say the same thing in the same repository", async () => {
    const { fakes, deps } = harness();
    const first = memory(STATEMENT);
    const sameHash = memory("use pnpm never npm in this repository");
    const otherRepo = memory(STATEMENT, { repos: ["github.com/acme/web"] });
    const unrelated = memory("Pin the toolchain versions.");
    fakes.memories.push(first, sameHash, otherRepo, unrelated);

    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [first.publicId] }],
      sameText: true,
    });

    expect(result.records[0]?.memoryIds).toEqual([first.publicId, sameHash.publicId]);
    expect(otherRepo.state).toBe("waiting");
    expect(unrelated.state).toBe("waiting");
  });

  it("cites only the memories named when same_text is off", async () => {
    const { fakes, deps } = harness();
    const first = memory(STATEMENT);
    const twin = memory("use pnpm never npm in this repository");
    fakes.memories.push(first, twin);
    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [first.publicId] }],
      sameText: false,
    });
    expect(result.records[0]?.memoryIds).toEqual([first.publicId]);
    expect(twin.state).toBe("waiting");
  });

  it("skips a memory the workspace does not hold and one that is not waiting, and keeps the rest", async () => {
    const { fakes, deps } = harness();
    const dismissed = memory("Pin the toolchain versions.", { state: "dismissed" });
    const waiting = memory(STATEMENT);
    fakes.memories.push(dismissed, waiting);

    const result = await promoteMemories(deps, SCOPE, {
      drafts: [
        { memory_ids: ["mem_missing", dismissed.publicId] },
        { memory_ids: [waiting.publicId] },
      ],
      sameText: true,
    });

    expect(result.skipped).toEqual([
      { memoryId: "mem_missing", reason: "not_found" },
      { memoryId: dismissed.publicId, reason: "not_waiting" },
    ]);
    expect(result.records.map((r) => r.memoryIds)).toEqual([[waiting.publicId]]);
  });

  it("does not cite one memory in two records", async () => {
    const { fakes, deps } = harness();
    const m = memory(STATEMENT);
    fakes.memories.push(m);
    const result = await promoteMemories(deps, SCOPE, {
      drafts: [{ memory_ids: [m.publicId] }, { memory_ids: [m.publicId] }],
      sameText: true,
    });
    expect(result.records).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("asks the host nothing when no memory can be promoted", async () => {
    const { gh, fakes, deps } = harness();
    gh.repository = null;
    const m = memory(STATEMENT, { state: "promoted", promotedLineage: "use-pnpm" });
    fakes.memories.push(m);
    await expect(
      promoteMemories(deps, SCOPE, { drafts: [{ memory_ids: [m.publicId] }], sameText: true }),
    ).resolves.toEqual({
      pullRequest: null,
      records: [],
      skipped: [{ memoryId: m.publicId, reason: "not_waiting" }],
    });
  });
});

describe("promoteMemories refusing", () => {
  it.each([
    [
      "a force the kind does not allow",
      { force: "must" as const },
      "force_not_allowed",
    ],
    [
      "an effect on a kind that is not a constraint",
      { effect: "require" as const },
      "effect_not_allowed",
    ],
  ])("refuses %s before it touches the repo", async (_name, over, reason) => {
    const { gh, fakes, deps } = harness();
    const m = memory(STATEMENT);
    fakes.memories.push(m);
    await expect(
      promoteMemories(deps, SCOPE, {
        drafts: [{ memory_ids: [m.publicId], ...over }],
        sameText: true,
      }),
    ).rejects.toMatchObject({ code: "conflict", reason });
    expect(gh.stamps).toEqual([]);
  });

  it("files a constraint memory as a memory when the draft names no kind, so it needs no effect", async () => {
    const { fakes, deps } = harness();
    const m = memory(STATEMENT, { kind: "constraint" });
    fakes.memories.push(m);
    await expect(
      promoteMemories(deps, SCOPE, { drafts: [{ memory_ids: [m.publicId] }], sameText: true }),
    ).resolves.toMatchObject({ records: [{ kind: "memory", force: "info", effect: null }] });
  });

  it("refuses a constraint draft that names no effect", async () => {
    const { fakes, deps } = harness();
    const m = memory(STATEMENT);
    fakes.memories.push(m);
    // The contract refuses this shape too. The handler checks it again,
    // because a draft that names no kind takes its kind from the memory.
    await expect(
      promoteMemories(deps, SCOPE, {
        drafts: [{ memory_ids: [m.publicId], kind: "constraint" }],
        sameText: true,
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "effect_required" });
  });

  it("refuses when the workspace has no steering repository", async () => {
    const { gh, fakes, deps } = harness();
    gh.repository = null;
    const m = memory(STATEMENT);
    fakes.memories.push(m);
    await expect(
      promoteMemories(deps, SCOPE, { drafts: [{ memory_ids: [m.publicId] }], sameText: true }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses when the repository holds no steering/governance.toml", async () => {
    const { gh, fakes, deps } = harness(new FakeGitHub());
    const m = memory(STATEMENT);
    fakes.memories.push(m);
    await expect(
      promoteMemories(deps, SCOPE, { drafts: [{ memory_ids: [m.publicId] }], sameText: true }),
    ).rejects.toMatchObject({ code: "conflict", reason: "steering_repo_required" });
    expect(gh.pulls).toEqual([]);
  });
});
