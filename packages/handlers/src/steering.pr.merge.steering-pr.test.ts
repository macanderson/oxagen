// merge_steering_pr on a steering PR proposal (#5122, ADR-265): the revert,
// tools, Markdown import, and memory PRs Oxagen opens each carry a proposal
// row, and the merge lands them through the merge queue with the stamp, the
// trailers, and the approvals. A merged revert that deleted a record's file
// retires the record. These tests run the openers and the merge over the
// in-memory store and the fake host, with the fixture steering repo on main.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // The opener's own check report. The merge runs its checks through the
  // steeringCheck seam instead, which each test passes.
  report: null as unknown,
}));

vi.mock("./context.steering.checks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context.steering.checks")>()),
  checkSteeringChange: vi.fn(async () => mocks.report),
}));

// The role gates read iam tables. Every caller here holds the contract's roles.
vi.mock("@oxagen/iam/org-role", async () => {
  const { HandlerError } = await import("@oxagen/oxagen");
  return {
    resolveActorOrgRole: async () => null,
    resolveActorWorkspaceRole: async () => null,
    resolveActingUserId: async (c: { userId: string | null }) => c.userId,
    assertOrgRole: async (actor: { userId: string | null }) => {
      if (!actor.userId)
        throw new HandlerError({ code: "forbidden", reason: "no_principal" });
      return "Member";
    },
  };
});

import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import type { CheckReport } from "@oxagen/steering-check";
import { createOpenSteeringPrHandler } from "./steering.pr.open";
import {
  createMergeSteeringPrHandler,
  type MergeSeams,
} from "./steering.pr.merge";
import { createRefreshSteeringPrHandler } from "./steering.pr.refresh";
import {
  createRevertSteeringPrHandler,
  type RevertDeps,
} from "./steering.pr.revert";
import { createProposeRecordHandler } from "./steering.proposal.create";
import {
  AUTHOR,
  REPO,
  REVIEWER,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";
import { MARKDOWN_IMPORT_PULL_REQUEST } from "./markdown-import/opener";
import type { SteeringPublisher } from "./steering-repo/publisher";
import { personAuthor } from "./steering-repo/pr-proposal";
import {
  createSteeringPullRequestOpener,
  TOOLS_PULL_REQUEST,
  type SteeringPullRequestKind,
  type ToolsPullRequestDeps,
} from "./tools.pr.open";

/** A workspace Owner with no organization role. */
const OWNER = "0192d4a8-7c1e-7a00-8000-0000000005e9";
const LEDGER = "steering/promotions/2026-09.jsonl";
const TOOLS_FILE = "tools/servers/billing/tools.toml";
const MEMORY_FILE = "steering/memory/platform/a-intel.platform.ci-cache-key.md";
const LINEAGE = "ctx.release.no-reread-changelog";

/** A report in which every check the merge trailer names passed. */
function passed(): CheckReport {
  return {
    passed: true,
    results: (["schema", "references", "owned"] as const).map((check) => ({
      check,
      status: "passed" as const,
      summary: `${check} passed`,
      findings: [],
    })),
    findings: [],
  };
}

/** A report with one error, so nothing merges. */
function failed(): CheckReport {
  const finding = {
    check: "schema" as const,
    rule: "missing-field",
    severity: "error" as const,
    path: TOOLS_FILE,
    line: 3,
    field: "tools.list_invoices.risk",
    message: "list_invoices has no risk.",
    expected: "risk is low, medium, or high.",
    fix: "Set risk on list_invoices.",
  };
  return {
    passed: false,
    results: [
      { check: "schema", status: "failed", summary: "1 error", findings: [finding] },
    ],
    findings: [finding],
  };
}

/** The fixture steering repo on main, in team mode, with a clock after its ledger. */
function steeringHarness(): Harness {
  const seed: Record<string, string> = {};
  for (const [path, text] of fixtureRepo()) seed[`main:${path}`] = text;
  const h = harness(seed);
  let t = Date.parse("2026-09-26T12:00:00.000Z");
  const clock = () => new Date((t += 1000));
  h.github.clock = clock;
  h.now = clock;
  h.roleOf.set(OWNER, { org: null, workspace: "Owner" });
  h.requestSync = vi.fn(async () => undefined);
  return h;
}

interface Seams extends MergeSeams {
  /** Each head the merge's checks ran on. */
  checked: string[];
  /** Each commit publish() ran at. */
  published: string[];
}

/** A publisher at version 20 that records each commit it publishes. */
function fakePublisher(published: string[]): SteeringPublisher {
  const held = async (commit: string) => {
    published.push(commit);
    return { status: "current" as const, version: 21, commit };
  };
  return {
    repository: (repo) => repo.fullName,
    store: {
      highestVersion: async () => 20,
      versionAt: async () => null,
      current: async () => null,
    },
    publish: async (_repo, commit) => held(commit),
    withLock: (_repo, fn) => fn(held),
  };
}

/** Merge seams for a healthy steering repo whose checks answer `report`. */
function seams(report: CheckReport = passed()): Seams {
  const checked: string[] = [];
  const published: string[] = [];
  return {
    checked,
    published,
    readHealth: async () => "healthy",
    steeringCheck: async (_scope, _host, _repo, head) => {
      checked.push(head);
      return report;
    },
    publisher: () => fakePublisher(published),
  };
}

function openerDeps(h: Harness): ToolsPullRequestDeps {
  return {
    host: () => h.github,
    readIndex: async () => null,
    readContext: async () => ({
      runtimes: [],
      members: [],
      teams: [],
      groups: [],
      credentials: [],
    }),
    proposals: h.store,
    now: h.now,
  };
}

/** Open a steering PR of `kind` that changes one file, as its opener does. */
async function openSteeringPr(
  h: Harness,
  kind: SteeringPullRequestKind,
  args: { branch: string; path: string; content: string },
) {
  return createSteeringPullRequestOpener(openerDeps(h), kind).open(
    { orgId: ctx().orgId, workspaceId: ctx().workspaceId },
    {
      branch: args.branch,
      title: `Change ${args.path}`,
      body: "A steering PR the test opened.",
      commitMessage: `Change ${args.path}`,
      files: [{ path: args.path, content: args.content }],
      author: personAuthor(AUTHOR),
    },
  );
}

/** The proposal row the opener wrote for PR `number`. */
function rowFor(h: Harness, number: number) {
  const row = h.store.proposals.find((p) => p.prNumber === number);
  if (!row) throw new Error(`no proposal row for #${number}`);
  return row;
}

async function toolsText(h: Harness): Promise<string> {
  return `${(await h.github.readFile(REPO, TOOLS_FILE, "main")) ?? ""}\n# edited by the test\n`;
}

beforeEach(() => {
  mocks.report = passed();
});

describe("a steering PR's opener writes its proposal row", () => {
  it("records a tools PR as a tools proposal on its branch, with the check's outcome", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });

    expect(h.store.proposals).toHaveLength(1);
    expect(rowFor(h, opened.number)).toMatchObject({
      kind: "tools",
      lineageId: "tools/billing",
      status: "checks_passed",
      branch: "tools/billing",
      path: "tools/servers/billing",
      prNumber: opened.number,
      headSha: opened.headSha,
      createdById: AUTHOR,
      source: `user:${AUTHOR}`,
      governanceMode: "team",
      checks: [],
    });
  });

  it("records a failed check as checks_failed, and moves the row when a commit is added", async () => {
    const h = steeringHarness();
    mocks.report = failed();
    const first = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    expect(rowFor(h, first.number).status).toBe("checks_failed");

    mocks.report = passed();
    const second = await createSteeringPullRequestOpener(
      openerDeps(h),
      TOOLS_PULL_REQUEST,
    ).open(
      { orgId: ctx().orgId, workspaceId: ctx().workspaceId },
      {
        branch: "tools/billing",
        title: "Change the billing tools again",
        body: "",
        commitMessage: "Change the billing tools again",
        files: [{ path: TOOLS_FILE, content: "# a second edit\n" }],
        existing: { number: first.number },
      },
    );

    expect(h.store.proposals).toHaveLength(1);
    expect(rowFor(h, first.number)).toMatchObject({
      status: "checks_passed",
      headSha: second.headSha,
    });
  });

  it("sets aside an open row on the same branch that names another PR", async () => {
    const h = steeringHarness();
    const first = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    // The host closed the PR and dropped its branch. The sync has not read it.
    h.github.closeOnHost(first.number);
    await h.github.deleteBranch(REPO, "tools/billing");

    const second = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });

    expect(rowFor(h, first.number)).toMatchObject({
      status: "rejected",
      dismissedReason: `Replaced by #${second.number} on tools/billing`,
    });
    expect(rowFor(h, second.number).status).toBe("checks_passed");
  });
});

describe("merge_steering_pr on a steering PR proposal", () => {
  it("lands a tools PR through the queue with the stamp, the trailers, and the approvals", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    const ledgerBefore = await h.github.readFile(REPO, LEDGER, "main");
    const s = seams();

    const out = await createMergeSteeringPrHandler(h, s)(
      { proposalId: rowFor(h, opened.number).publicId },
      ctx({ userId: REVIEWER }),
    );

    expect(out).toMatchObject({
      status: "merged",
      kind: "tools",
      pullRequest: { number: opened.number, branch: "tools/billing" },
      retired: [],
      publishedVersion: 21,
    });
    // The merge ran the steering checks on the head the row named.
    expect(s.checked).toEqual([opened.headSha]);
    expect(h.github.merges).toHaveLength(1);
    const merge = h.github.merges[0]!;
    expect(merge.commitTitle).toBe(`steering: merge tools/billing (#${opened.number})`);
    expect(merge.commitMessage).toContain(`Oxagen-Approved-By: ${REVIEWER}`);
    expect(merge.commitMessage).toContain("Oxagen-Checks: schema,references,owned");
    expect(merge.commitMessage).toContain("Oxagen-Version: 21");
    // The stamp commit added one ledger line naming the PR.
    const ledgerAfter = (await h.github.readFile(REPO, LEDGER, "main")) ?? "";
    expect(ledgerAfter.startsWith(ledgerBefore ?? "")).toBe(true);
    const line = JSON.parse(ledgerAfter.trimEnd().split("\n").at(-1) ?? "{}");
    expect(line).toMatchObject({
      branch: "tools/billing",
      pull_request: { provider: "github", number: opened.number },
      changes: [{ path: TOOLS_FILE, action: "modified" }],
    });
    expect(await h.github.readFile(REPO, TOOLS_FILE, "main")).toBe(
      await h.github.readFile(REPO, TOOLS_FILE, opened.headSha),
    );
    expect(h.github.deletedBranches).toContain("tools/billing");
    expect(s.published).toEqual([out.mergedCommit]);
    expect(rowFor(h, opened.number)).toMatchObject({
      status: "merged",
      mergedCommit: out.mergedCommit,
      mergedByUserId: REVIEWER,
      mergeClaimedAt: null,
    });
    expect(h.events.map((e) => e.eventType)).toContain("steering.published");
  });

  it("finishes a merge an earlier call claimed and landed, and merges nothing twice", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    const row = rowFor(h, opened.number);
    // An earlier call claimed the row and the host merged the PR. That call
    // failed before the row moved to merged, and its claim has lapsed.
    row.mergeClaimedAt = new Date("2026-09-26T11:49:00.000Z");
    const mergeSha = h.github.mergeOnHost(opened.number);
    const s = seams();

    const out = await createMergeSteeringPrHandler(h, s)(
      { proposalId: row.publicId },
      ctx({ userId: REVIEWER }),
    );

    expect(out).toMatchObject({ kind: "tools", mergedCommit: mergeSha, retired: [] });
    // The resume lands nothing again and runs no checks on a merged PR.
    expect(h.github.merges).toEqual([]);
    expect(s.checked).toEqual([]);
    expect(rowFor(h, opened.number)).toMatchObject({
      status: "merged",
      mergedCommit: mergeSha,
      mergedByUserId: REVIEWER,
    });
  });

  it("brings a branch that fell behind up to date and runs the steering checks again on the new head", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    h.github.commit(
      REPO.defaultBranch,
      "steering/platform/release-notes.md",
      "Every release has notes.\n",
    );
    const s = seams();

    const out = await createMergeSteeringPrHandler(h, s)(
      { proposalId: rowFor(h, opened.number).publicId },
      ctx({ userId: REVIEWER }),
    );

    expect(out.kind).toBe("tools");
    expect(h.github.updates).toEqual([
      expect.objectContaining({ branch: "tools/billing" }),
    ]);
    // Once on the head the row named, once on the head the update made.
    expect(s.checked).toHaveLength(2);
    expect(s.checked[0]).toBe(opened.headSha);
    expect(s.checked[1]).not.toBe(opened.headSha);
    expect(rowFor(h, opened.number).status).toBe("merged");
  });

  it("records checks_failed and merges nothing when the checks fail on the updated head (negative)", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    h.github.commit(
      REPO.defaultBranch,
      "steering/platform/release-notes.md",
      "Every release has notes.\n",
    );
    let calls = 0;
    const s: Seams = {
      ...seams(),
      steeringCheck: async () => (++calls === 1 ? passed() : failed()),
    };

    await expect(
      createMergeSteeringPrHandler(h, s)(
        { proposalId: rowFor(h, opened.number).publicId },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "checks_failed" });

    expect(calls).toBe(2);
    expect(h.github.merges).toEqual([]);
    expect(rowFor(h, opened.number)).toMatchObject({
      status: "checks_failed",
      mergeClaimedAt: null,
    });
  });

  it("refuses the author's own merge in team mode, as for a record", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    h.roleOf.set(AUTHOR, { org: "Admin", workspace: null });

    await expect(
      createMergeSteeringPrHandler(h, seams())(
        { proposalId: rowFor(h, opened.number).publicId },
        ctx({ userId: AUTHOR }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "separation_of_duties" });
    expect(h.github.merges).toHaveLength(0);
  });

  it("lands a Markdown import PR the same way", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, MARKDOWN_IMPORT_PULL_REQUEST, {
      branch: "steering/import-2026-09-26",
      path: "policy/live.cedar",
      content: 'forbid (principal, action, resource) when { context.tool.side_effect == "irreversible" };\n',
    });
    expect(rowFor(h, opened.number)).toMatchObject({
      kind: "import",
      lineageId: "steering/import-2026-09-26",
      path: "policy",
    });

    const out = await createMergeSteeringPrHandler(h, seams())(
      { proposalId: rowFor(h, opened.number).publicId },
      ctx({ userId: REVIEWER }),
    );

    expect(out).toMatchObject({ kind: "import", retired: [] });
    expect(await h.github.readFile(REPO, "policy/live.cedar", "main")).not.toBeNull();
  });

  it("lands a memory PR, which opens with no check, once the merge's own check passes", async () => {
    const h = steeringHarness();
    const branch = "memory/2026-09-26";
    await h.github.ensureBranch(REPO, branch, "main");
    const text = (await h.github.readFile(REPO, MEMORY_FILE, "main")) ?? "";
    const head = h.github.commit(branch, MEMORY_FILE, `${text}\nRead the lockfile first.\n`);
    const pr = await h.github.openPullRequest(REPO, {
      title: "Memory PR 2026-09-26",
      head: branch,
      base: "main",
      body: "",
    });
    const { recordSteeringPrQuietly } = await import("./steering-repo/pr-proposal");
    const row = await recordSteeringPrQuietly(h.store, {
      scope: { orgId: ctx().orgId, workspaceId: ctx().workspaceId },
      repo: REPO,
      kind: "memory_pr",
      pullRequest: { number: pr.number, url: pr.htmlUrl, branch, headSha: head },
      title: "Memory PR 2026-09-26",
      paths: [MEMORY_FILE],
      check: null,
      author: { userId: null, source: "memory-curator" },
    });
    expect(row).toMatchObject({ status: "pr_open", createdById: null, path: "steering/memory/platform" });
    const s = seams();

    const out = await createMergeSteeringPrHandler(h, s)(
      { proposalId: row!.publicId },
      ctx({ userId: REVIEWER }),
    );

    expect(out).toMatchObject({ kind: "memory_pr", pullRequest: { number: pr.number } });
    expect(s.checked).toEqual([head]);
    // The stamp wrote the record's new id and hash before the merge.
    const merged = (await h.github.readFile(REPO, MEMORY_FILE, "main")) ?? "";
    expect(merged).toContain("Read the lockfile first.");
    expect(merged).not.toContain(
      "hash: sha256:cd6685d7f6a65702d04489d6b7b6647116c8b7787b5022746f2802fc5f88edff",
    );
  });

  it("refuses when the steering checks fail on the head, and records checks_failed", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });

    await expect(
      createMergeSteeringPrHandler(h, seams(failed()))(
        { proposalId: rowFor(h, opened.number).publicId },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "checks_failed" });

    expect(h.github.merges).toHaveLength(0);
    expect(rowFor(h, opened.number)).toMatchObject({
      status: "checks_failed",
      mergeClaimedAt: null,
    });
    expect(h.github.checkRuns.at(-1)).toMatchObject({
      name: "Oxagen steering",
      headSha: opened.headSha,
      conclusion: "failure",
    });
  });

  it("refuses a moved head until the row follows it, then merges the new head", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    const proposalId = rowFor(h, opened.number).publicId;
    const pushed = h.github.commit("tools/billing", TOOLS_FILE, "# pushed on the host\n");
    const s = seams();
    const merge = createMergeSteeringPrHandler(h, s);

    await expect(
      merge({ proposalId }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ code: "conflict", reason: "head_moved" });

    await createRefreshSteeringPrHandler(h)({ proposalId }, ctx({ userId: REVIEWER }));
    expect(rowFor(h, opened.number)).toMatchObject({
      status: "pr_open",
      headSha: pushed,
      checks: [],
    });
    // A new head needs its own approval, so the default one names it.
    const out = await merge({ proposalId }, ctx({ userId: REVIEWER }));
    expect(out.kind).toBe("tools");
    expect(s.checked).toEqual([pushed]);
  });

  it("refuses a PR someone merged on the host, and asks the sync to read it", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    h.github.mergeOnHost(opened.number);

    await expect(
      createMergeSteeringPrHandler(h, seams())(
        { proposalId: rowFor(h, opened.number).publicId },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "merged_outside_oxagen" });
    expect(h.requestSync).toHaveBeenCalled();
    expect(rowFor(h, opened.number).status).toBe("checks_passed");
  });

  it("is refused by open_steering_pr, which runs only the record checks", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });

    await expect(
      createOpenSteeringPrHandler(h)(
        { proposalId: rowFor(h, opened.number).publicId },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "steering_pr_proposal" });
  });
});

describe("a revert steering PR", () => {
  function revert(h: Harness) {
    const deps: RevertDeps = {
      steering: h,
      checks: {
        readIndex: async () => null,
        readContext: async () => ({
          runtimes: [],
          members: [],
          teams: [],
          groups: [],
          credentials: [],
        }),
        now: h.now,
      },
    };
    return createRevertSteeringPrHandler(deps);
  }

  const proposalInput = (statement: string) =>
    steeringProposalCreate.input.parse({
      record: {
        lineageId: LINEAGE,
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement,
      },
      rationale: "682 duplicate tool calls across 212 runs.",
    });

  /** Propose the record, open its PR, and merge it through Oxagen. */
  async function mergedRecord(h: Harness): Promise<string> {
    const { proposalId } = await createProposeRecordHandler(h)(
      proposalInput("Do not re-read CHANGELOG.md more than once in a run."),
      ctx(),
    );
    await createOpenSteeringPrHandler(h)({ proposalId }, ctx());
    await createMergeSteeringPrHandler(h)({ proposalId }, ctx({ userId: REVIEWER }));
    return proposalId;
  }

  it("carries a revert proposal on the record's lineage, and its merge retires the record", async () => {
    const h = steeringHarness();
    const proposalId = await mergedRecord(h);
    const record = h.store.records.find((r) => r.slug === LINEAGE);
    expect(record?.status).toBe("active");
    const ledgerBefore = await h.store.ledgerLength({ workspaceId: ctx().workspaceId });

    const opened = await revert(h)({ proposalId }, ctx({ userId: OWNER }));

    expect(opened.revertProposalId).not.toBeNull();
    const row = h.store.proposals.find((p) => p.publicId === opened.revertProposalId);
    expect(row).toMatchObject({
      kind: "revert",
      lineageId: LINEAGE,
      path: record?.path,
      branch: "steering/revert-519",
      prNumber: opened.pullRequest.number,
      headSha: opened.pullRequest.headSha,
      createdById: OWNER,
    });

    const out = await createMergeSteeringPrHandler(h, seams())(
      { proposalId: opened.revertProposalId! },
      ctx({ userId: REVIEWER }),
    );

    expect(out).toMatchObject({
      kind: "revert",
      retired: [LINEAGE],
      bundleVersion: { before: ledgerBefore, after: ledgerBefore + 1 },
    });
    expect(await h.github.readFile(REPO, record?.path ?? "", "main")).toBeNull();
    expect(h.store.records.find((r) => r.slug === LINEAGE)).toMatchObject({
      status: "retired",
      commitSha: out.mergedCommit,
    });
    expect(h.store.ledger.at(-1)).toMatchObject({
      recordId: record?.id,
      action: "retire",
      approverUserId: REVIEWER,
    });
  });

  it("is refused while another PR on the record is open", async () => {
    const h = steeringHarness();
    const proposalId = await mergedRecord(h);
    const { proposalId: revision } = await createProposeRecordHandler(h)(
      proposalInput("Read CHANGELOG.md once per run, then use the cached copy."),
      ctx(),
    );
    await createOpenSteeringPrHandler(h)({ proposalId: revision }, ctx());
    const pulls = h.github.pulls.length;

    await expect(
      revert(h)({ proposalId }, ctx({ userId: OWNER })),
    ).rejects.toMatchObject({ code: "conflict", reason: "lineage_pr_open" });
    expect(h.github.pulls).toHaveLength(pulls);
  });

  it("reverts a revision, which puts the earlier file back and retires nothing", async () => {
    const h = steeringHarness();
    await mergedRecord(h);
    const { proposalId: revision } = await createProposeRecordHandler(h)(
      proposalInput("Read CHANGELOG.md once per run, then use the cached copy."),
      ctx(),
    );
    await createOpenSteeringPrHandler(h)({ proposalId: revision }, ctx());
    await createMergeSteeringPrHandler(h)({ proposalId: revision }, ctx({ userId: REVIEWER }));
    const record = h.store.records.find((r) => r.slug === LINEAGE);

    const reverted = await revert(h)({ proposalId: revision }, ctx({ userId: OWNER }));
    const out = await createMergeSteeringPrHandler(h, seams())(
      { proposalId: reverted.revertProposalId! },
      ctx({ userId: REVIEWER }),
    );

    expect(out).toMatchObject({ kind: "revert", retired: [] });
    expect(await h.github.readFile(REPO, record?.path ?? "", "main")).toContain(
      "Do not re-read CHANGELOG.md more than once in a run.",
    );
    expect(h.store.records.find((r) => r.slug === LINEAGE)?.status).toBe("active");
  });

  it("reverts a merged tools PR on a revert branch of its own, and retires nothing", async () => {
    const h = steeringHarness();
    const opened = await openSteeringPr(h, TOOLS_PULL_REQUEST, {
      branch: "tools/billing",
      path: TOOLS_FILE,
      content: await toolsText(h),
    });
    const toolsProposal = rowFor(h, opened.number).publicId;
    await createMergeSteeringPrHandler(h, seams())(
      { proposalId: toolsProposal },
      ctx({ userId: REVIEWER }),
    );

    const reverted = await revert(h)({ proposalId: toolsProposal }, ctx({ userId: OWNER }));
    const row = h.store.proposals.find((p) => p.publicId === reverted.revertProposalId);
    expect(row).toMatchObject({
      kind: "revert",
      lineageId: `tools/revert-${opened.number}`,
      path: "tools/servers/billing",
    });

    const out = await createMergeSteeringPrHandler(h, seams())(
      { proposalId: reverted.revertProposalId! },
      ctx({ userId: REVIEWER }),
    );
    expect(out).toMatchObject({ kind: "revert", retired: [] });
  });
});
