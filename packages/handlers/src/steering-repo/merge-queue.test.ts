import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { REQUIRED_CHECK_NAME } from "@oxagen/oxagen/steering-repo/names";
import {
  GOVERNANCE_TOML_PATH,
  LEGACY_GOVERNANCE_PATH,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  ledgerChainBreaks,
  promotionSchema,
  type PromotionLine,
} from "@oxagen/oxagen/steering-repo/promotion";
import {
  AUTHOR,
  FakeGitHub,
  REPO,
  REVIEWER,
} from "../context.steering.test-support";
import { logger } from "../logger";
import {
  assertHealthy,
  inMergeQueue,
  landSteeringPr,
  mergeApproval,
  mergeQueueKey,
  openRevertPr,
  readSteeringLayout,
  recordPublishDeployment,
  type ApprovalInput,
  type LandInput,
  type MergeApproval,
  type RecheckResult,
} from "./merge-queue";
import { mergeTrailers, steeringBranch } from "./stamp";

const LEDGER = "steering/promotions/2026-09.jsonl";
const CHECKS = ["schema", "lineage", "hash"] as const;
const MEMBER = "0192d4a8-7c1e-7a00-8000-0000000005e3";
const GUEST = "0192d4a8-7c1e-7a00-8000-0000000005e4";

/** A steering record without its id and hash, as an author writes one. */
function record(lineage: string, body = "Every release has notes."): string {
  return [
    "---",
    "schema: steering-record/v1",
    `lineage: ${lineage}`,
    "label: A rule",
    "kind: rule",
    "force: must",
    "scope: workspace",
    "status: active",
    "origin: user",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function recordPath(lineage: string): string {
  return `steering/platform/${lineage}.md`;
}

/** The fixture steering repo on main, and a clock that starts on 26 September. */
function steeringRepo(): FakeGitHub {
  const seed: Record<string, string> = {};
  for (const [path, text] of fixtureRepo()) seed[`main:${path}`] = text;
  const gh = new FakeGitHub(seed);
  let t = Date.parse("2026-09-26T12:00:00Z");
  gh.clock = () => new Date((t += 1000));
  return gh;
}

function clockFrom(iso: string): () => Date {
  let t = Date.parse(iso);
  return () => new Date((t += 1000));
}

interface OpenPr {
  number: number;
  branch: string;
  head: string;
  path: string;
}

/** Open a steering PR that adds (or changes) one record. */
async function openPr(
  gh: FakeGitHub,
  lineage: string,
  text = record(lineage),
  path = recordPath(lineage),
): Promise<OpenPr> {
  const branch = steeringBranch(lineage);
  await gh.ensureBranch(REPO, branch, REPO.defaultBranch);
  const head = gh.commit(branch, path, text);
  const { number } = await gh.openPullRequest(REPO, {
    title: lineage,
    head: branch,
    base: REPO.defaultBranch,
    body: "",
  });
  return { number, branch, head, path };
}

async function land(
  gh: FakeGitHub,
  pr: OpenPr,
  over: Partial<LandInput> = {},
) {
  return landSteeringPr({
    host: gh,
    repo: REPO,
    number: pr.number,
    branch: pr.branch,
    checkedHead: pr.head,
    checks: CHECKS,
    layout: await readSteeringLayout(gh, REPO),
    approve: async () => ({ approvedBy: [REVIEWER], withoutReview: false }),
    mergedBy: REVIEWER,
    commitTitle: `steering: publish (#${pr.number})`,
    version: 21,
    now: clockFrom("2026-09-26T12:00:00Z"),
    recheck: async () => ({ ok: true, checks: CHECKS }),
    ...over,
  });
}

async function ledgerLines(
  gh: FakeGitHub,
  path = LEDGER,
  ref = REPO.defaultBranch,
): Promise<PromotionLine[]> {
  const text = (await gh.readFile(REPO, path, ref)) ?? "";
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => promotionSchema.parse(JSON.parse(line)) as PromotionLine);
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; reason?: string; message: string };
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
});

describe("inMergeQueue", () => {
  it("keys one queue per repository on its host, whatever the case of its name", () => {
    expect(mergeQueueKey({ ...REPO, fullName: "A-Intel/Platform" })).toBe(
      "github:a-intel/platform",
    );
    expect(mergeQueueKey({ ...REPO, provider: "gitlab" })).toBe(
      "gitlab:a-intel/platform",
    );
  });

  it("runs merges on one repository one at a time, in the order they arrived", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = inMergeQueue(REPO, async () => {
      order.push("first start");
      await gate;
      order.push("first end");
      return 1;
    });
    const second = inMergeQueue({ ...REPO, fullName: "A-Intel/Platform" }, async () => {
      order.push("second");
      return 2;
    });
    const other = inMergeQueue({ ...REPO, fullName: "a-intel/other" }, async () => {
      order.push("other");
      return 3;
    });
    // Another repository's merge does not wait behind this one.
    await expect(other).resolves.toBe(3);
    expect(order).toEqual(["first start", "other"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first start", "other", "first end", "second"]);
  });

  it("lets the next merge run after one is refused", async () => {
    const refused = inMergeQueue(REPO, async () => {
      throw new Error("refused");
    });
    const next = inMergeQueue(REPO, async () => "ran");
    await expect(refused).rejects.toThrow("refused");
    await expect(next).resolves.toBe("ran");
  });
});

describe("readSteeringLayout", () => {
  it("reads steering/governance.toml in a steering repo", async () => {
    const layout = await readSteeringLayout(steeringRepo(), REPO);
    expect(layout).toMatchObject({
      layout: "steering",
      mode: "team",
      settings: { rotate: "month", max_lines: 10000 },
    });
  });

  it("falls back to the legacy governance file, and its default mode, elsewhere", async () => {
    const legacy = new FakeGitHub({
      [`main:${LEGACY_GOVERNANCE_PATH}`]: 'mode = "solo"\n',
    });
    await expect(readSteeringLayout(legacy, REPO)).resolves.toEqual({
      layout: "legacy",
      mode: "solo",
    });
    await expect(readSteeringLayout(new FakeGitHub(), REPO)).resolves.toEqual({
      layout: "legacy",
      mode: "team",
    });
  });

  it("refuses a governance file it cannot read, in either layout", async () => {
    const gh = steeringRepo();
    gh.commit("main", GOVERNANCE_TOML_PATH, 'schema = "governance/v1"\nmode = "team"\n');
    const steering = await refusal(readSteeringLayout(gh, REPO));
    expect(steering).toMatchObject({ reason: "governance_unreadable" });
    expect(steering.message).toContain(GOVERNANCE_TOML_PATH);

    const legacy = new FakeGitHub({
      [`main:${LEGACY_GOVERNANCE_PATH}`]: 'mode = "chaos"\n',
    });
    await expect(refusal(readSteeringLayout(legacy, REPO))).resolves.toMatchObject({
      reason: "governance_unreadable",
    });
  });
});

describe("assertHealthy", () => {
  it("passes a healthy repository and refuses every other state", () => {
    expect(() => assertHealthy("healthy", REPO)).not.toThrow();
    for (const health of ["drifted", "disconnected", "diverged"] as const) {
      let thrown: unknown = null;
      try {
        assertHealthy(health, REPO);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({
        code: "conflict",
        reason: "repository_unhealthy",
      });
      expect((thrown as Error).message).toContain(health);
    }
  });
});

describe("mergeApproval", () => {
  async function input(
    gh: FakeGitHub,
    over: Partial<ApprovalInput> = {},
  ): Promise<ApprovalInput> {
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    return {
      host: gh,
      repo: REPO,
      number: pr.number,
      mode: "team",
      checkedHead: pr.head,
      authorUserId: AUTHOR,
      merger: { userId: MEMBER, orgRole: null, workspaceRole: "Member" },
      isMember: async (userId) => userId !== GUEST,
      holdsMergeWithoutReview: async () => false,
      ...over,
    };
  }

  it("needs no approval in solo mode: the merger is the approver", async () => {
    const gh = steeringRepo();
    const list = vi.spyOn(gh, "listApprovals");
    await expect(mergeApproval(await input(gh, { mode: "solo" }))).resolves.toEqual({
      approvedBy: [MEMBER],
      withoutReview: false,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("counts a linked member's approval at the checked head", async () => {
    const gh = steeringRepo();
    await expect(mergeApproval(await input(gh))).resolves.toEqual({
      approvedBy: [REVIEWER],
      withoutReview: false,
    });
  });

  it("ignores strangers, the author, guests, and approvals of an older head", async () => {
    const gh = steeringRepo();
    const args = await input(gh);
    gh.approvals = [
      { userId: null, login: "stranger", commitSha: args.checkedHead },
      { userId: AUTHOR, login: "author", commitSha: args.checkedHead },
      { userId: MEMBER, login: "member", commitSha: "an-older-head" },
      { userId: GUEST, login: "guest", commitSha: args.checkedHead },
      // GitLab does not say which head was approved, so the approval stands.
      { userId: REVIEWER, login: "reviewer", commitSha: null },
      { userId: REVIEWER, login: "reviewer", commitSha: args.checkedHead },
    ];
    await expect(mergeApproval(args)).resolves.toEqual({
      approvedBy: [REVIEWER],
      withoutReview: false,
    });
  });

  it("lets an owner, or a holder of merge_without_review, merge without an approval", async () => {
    const gh = steeringRepo();
    gh.approvals = [];
    const withoutReview = { approvedBy: [], withoutReview: true };
    await expect(
      mergeApproval(
        await input(gh, {
          merger: { userId: MEMBER, orgRole: "Owner", workspaceRole: null },
        }),
      ),
    ).resolves.toEqual(withoutReview);

    const workspaceOwner = steeringRepo();
    workspaceOwner.approvals = [];
    await expect(
      mergeApproval(
        await input(workspaceOwner, {
          merger: { userId: MEMBER, orgRole: null, workspaceRole: "Owner" },
        }),
      ),
    ).resolves.toEqual(withoutReview);

    const holder = steeringRepo();
    holder.approvals = [];
    await expect(
      mergeApproval(
        await input(holder, { holdsMergeWithoutReview: async () => true }),
      ),
    ).resolves.toEqual(withoutReview);
  });

  it("refuses anyone else until someone approves", async () => {
    const gh = steeringRepo();
    gh.approvals = [];
    await expect(refusal(mergeApproval(await input(gh)))).resolves.toMatchObject({
      code: "forbidden",
      reason: "approval_required",
    });
  });
});

describe("landSteeringPr: stamping", () => {
  it("stamps the record, appends the ledger line, and merges at the stamp with the trailers", async () => {
    const gh = steeringRepo();
    const before = await ledgerLines(gh);
    const pr = await openPr(gh, "a-intel.platform.release-notes");

    const landed = await land(gh, pr);

    expect(gh.stamps).toHaveLength(1);
    const stamp = gh.stamps[0]!;
    expect(stamp).toMatchObject({
      branch: pr.branch,
      parent: pr.head,
      message: `steering: stamp #${pr.number}`,
    });
    expect(landed).toMatchObject({
      commitSha: `merge${pr.number}`,
      mergedHead: stamp.sha,
      checkedHead: pr.head,
      attempts: 1,
    });

    // The record on main carries its id and hash.
    const published = (await gh.readFile(REPO, pr.path, "main")) ?? "";
    expect(published).toMatch(/\nid: rec_a_intel_platform_release_notes_[0-9a-f]+\n/);
    expect(published).toMatch(/\nhash: sha256:[0-9a-f]{64}\n---\n/);

    // The ledger gains one line that continues the chain.
    const after = await ledgerLines(gh);
    expect(after).toHaveLength(before.length + 1);
    expect(ledgerChainBreaks(after, null, 1)).toEqual([]);
    const line = after[after.length - 1]!;
    expect(line).toMatchObject({
      seq: before.length + 1,
      prev: before[before.length - 1]!.hash,
      pull_request: { provider: "github", number: pr.number },
      branch: pr.branch,
      mode: "team",
      approved_by: [REVIEWER],
      merged_by: REVIEWER,
      without_review: false,
      changes: [
        {
          path: pr.path,
          action: "added",
          lineage: "a-intel.platform.release-notes",
        },
      ],
    });
    expect(published).toContain(`id: ${line.changes[0]!.id}`);
    expect(published).toContain(`hash: ${line.changes[0]!.hash}`);
    expect(landed.stamp).toMatchObject({
      ledgerPath: LEDGER,
      seq: line.seq,
      hash: line.hash,
    });

    // The required check stands on the stamp, naming the commit it ran on.
    expect(gh.checkRuns).toEqual([
      expect.objectContaining({
        name: REQUIRED_CHECK_NAME,
        headSha: stamp.sha,
        conclusion: "success",
      }),
    ]);
    expect(gh.checkRuns[0]!.summary).toContain(pr.head);

    expect(gh.merges).toEqual([
      {
        number: pr.number,
        commitTitle: `steering: publish (#${pr.number})`,
        sha: stamp.sha,
        commitMessage: mergeTrailers({
          approvedBy: [REVIEWER],
          withoutReviewBy: null,
          checks: CHECKS,
          version: 21,
        }),
      },
    ]);
  });

  it("records who merged without review in the ledger and the trailers", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    await land(gh, pr, {
      approve: async () => ({ approvedBy: [], withoutReview: true }),
      mergedBy: MEMBER,
    });
    const line = (await ledgerLines(gh)).at(-1)!;
    expect(line).toMatchObject({
      approved_by: [],
      merged_by: MEMBER,
      without_review: true,
    });
    expect(gh.merges[0]!.commitMessage).toContain(
      `Oxagen-Approved-By: none; merged without review by ${MEMBER}`,
    );
  });

  it("stamps a changed record again and lists a removed one without a stamp", async () => {
    const gh = steeringRepo();
    const lineage = "a-intel.platform.headings-sentence-case";
    const path = recordPath(lineage);
    const old = (await gh.readFile(REPO, path, "main"))!;
    const pr = await openPr(
      gh,
      lineage,
      old.replace("Write every heading", "Write each heading"),
      path,
    );
    await land(gh, pr);
    const changed = (await ledgerLines(gh)).at(-1)!.changes[0]!;
    expect(changed).toMatchObject({ path, action: "modified", lineage });
    const oldHash = /\nhash: (\S+)\n/.exec(old)?.[1];
    expect(changed.hash).not.toBe(oldHash);

    const removed = recordPath("a-intel.platform.migration-names");
    const branch = steeringBranch("a-intel.platform.migration-names");
    await gh.ensureBranch(REPO, branch, REPO.defaultBranch);
    const head = gh.remove(branch, removed);
    const { number } = await gh.openPullRequest(REPO, {
      title: "Retire migration names",
      head: branch,
      base: REPO.defaultBranch,
      body: "",
    });
    await land(gh, { number, branch, head, path: removed });
    expect((await ledgerLines(gh)).at(-1)!.changes).toEqual([
      { path: removed, action: "removed" },
    ]);
    expect(await gh.readFile(REPO, removed, "main")).toBeNull();
  });

  it("opens the next period's file when the period turns, carrying the chain", async () => {
    const gh = steeringRepo();
    const september = await ledgerLines(gh);
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    await land(gh, pr, { now: clockFrom("2026-10-01T00:00:00Z") });

    expect(await ledgerLines(gh)).toEqual(september);
    const october = await ledgerLines(gh, "steering/promotions/2026-10.jsonl");
    expect(october).toHaveLength(1);
    expect(october[0]).toMatchObject({
      seq: september.length + 1,
      prev: september.at(-1)!.hash,
    });
  });

  it("opens the period's next file at the max_lines cap", async () => {
    const gh = steeringRepo();
    const governance = (await gh.readFile(REPO, GOVERNANCE_TOML_PATH, "main"))!;
    gh.commit(
      "main",
      GOVERNANCE_TOML_PATH,
      governance.replace("max_lines = 10000", "max_lines = 20"),
    );
    const full = await ledgerLines(gh);
    expect(full).toHaveLength(20);
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    await land(gh, pr);

    const next = await ledgerLines(gh, "steering/promotions/2026-09.002.jsonl");
    expect(next).toEqual([
      expect.objectContaining({ seq: 21, prev: full.at(-1)!.hash }),
    ]);
    expect(await ledgerLines(gh)).toEqual(full);
  });

  it("merges a legacy repository at the checked head, without a stamp", async () => {
    const gh = new FakeGitHub({
      [`main:${LEGACY_GOVERNANCE_PATH}`]: 'mode = "solo"\n',
    });
    const pr = await openPr(
      gh,
      "a-intel.platform.release-notes",
      'lineage = "a-intel.platform.release-notes"\n',
      ".oxagen/rules/a-intel.platform.release-notes.toml",
    );
    const landed = await land(gh, pr);
    expect(landed).toMatchObject({ mergedHead: pr.head, stamp: null });
    expect(gh.stamps).toEqual([]);
    expect(gh.checkRuns).toEqual([]);
    expect(gh.merges).toEqual([
      expect.objectContaining({ sha: pr.head, commitMessage: expect.stringContaining("Oxagen-Version: 21") }),
    ]);
  });
});

describe("landSteeringPr: refusals before the stamp", () => {
  async function refusedLanding(
    setup: (gh: FakeGitHub) => Promise<OpenPr>,
  ): Promise<{ gh: FakeGitHub; err: Awaited<ReturnType<typeof refusal>> }> {
    const gh = steeringRepo();
    const pr = await setup(gh);
    const err = await refusal(land(gh, pr));
    expect(gh.stamps).toEqual([]);
    expect(gh.merges).toEqual([]);
    return { gh, err };
  }

  it("refuses a PR that writes the ledger", async () => {
    const { err } = await refusedLanding(async (gh) => {
      const pr = await openPr(gh, "a-intel.platform.release-notes");
      const head = gh.commit(pr.branch, LEDGER, "{}\n");
      return { ...pr, head };
    });
    expect(err).toMatchObject({ reason: "ledger_owned" });
  });

  it("refuses a steering/ PR that changes two records", async () => {
    const { err } = await refusedLanding(async (gh) => {
      const pr = await openPr(gh, "a-intel.platform.release-notes");
      const head = gh.commit(
        pr.branch,
        recordPath("a-intel.platform.review-dates"),
        record("a-intel.platform.review-dates"),
      );
      return { ...pr, head };
    });
    expect(err).toMatchObject({ reason: "one_change" });
  });

  it("refuses a path outside the branch's folder, and a branch without a prefix", async () => {
    const { err: scope } = await refusedLanding(async (gh) => {
      const pr = await openPr(gh, "a-intel.platform.release-notes");
      const head = gh.commit(pr.branch, "tools/toolbelts/refunds.toml", "x = 1\n");
      return { ...pr, head };
    });
    expect(scope).toMatchObject({ reason: "branch_scope" });

    const { err: prefix } = await refusedLanding(async (gh) => {
      const branch = "context/a-intel.platform.release-notes";
      await gh.ensureBranch(REPO, branch, "main");
      const head = gh.commit(
        branch,
        recordPath("a-intel.platform.release-notes"),
        record("a-intel.platform.release-notes"),
      );
      const { number } = await gh.openPullRequest(REPO, {
        title: "t",
        head: branch,
        base: "main",
        body: "",
      });
      return { number, branch, head, path: "" };
    });
    expect(prefix).toMatchObject({ reason: "branch_prefix" });
  });

  it("refuses a PR that changes nothing, and a record it cannot stamp", async () => {
    const { err: empty } = await refusedLanding(async (gh) => {
      const branch = steeringBranch("a-intel.platform.release-notes");
      await gh.ensureBranch(REPO, branch, "main");
      const { number } = await gh.openPullRequest(REPO, {
        title: "t",
        head: branch,
        base: "main",
        body: "",
      });
      return { number, branch, head: (await gh.branchHead(REPO, branch))!, path: "" };
    });
    expect(empty).toMatchObject({ reason: "nothing_to_merge" });

    const { err: unstampable } = await refusedLanding((gh) =>
      openPr(gh, "a-intel.platform.release-notes", "no frontmatter here\n"),
    );
    expect(unstampable).toMatchObject({ reason: "stamp_refused" });
  });

  it("refuses a repository whose production branch is gone", async () => {
    const { err } = await refusedLanding(async (gh) => {
      const pr = await openPr(gh, "a-intel.platform.release-notes");
      gh.heads.delete("main");
      return pr;
    });
    expect(err).toMatchObject({ reason: "production_branch_missing" });
  });
});

describe("landSteeringPr: when main moves", () => {
  it("brings the branch up to date and checks it again before stamping", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    gh.commit("main", "README.md", "moved\n");
    const rechecked: string[] = [];
    const landed = await land(gh, pr, {
      recheck: async (head) => {
        rechecked.push(head);
        return { ok: true, checks: ["schema", "lineage", "hash", "budget"] };
      },
    });

    expect(gh.updates).toEqual([
      { branch: pr.branch, from: pr.head, to: expect.any(String) },
    ]);
    const updated = gh.updates[0]!.to;
    expect(rechecked).toEqual([updated]);
    expect(gh.stamps[0]!.parent).toBe(updated);
    expect(landed.checkedHead).toBe(updated);
    expect(gh.merges[0]!.commitMessage).toContain(
      "Oxagen-Checks: schema,lineage,hash,budget",
    );
    expect(await gh.readFile(REPO, "README.md", "main")).toBe("moved\n");
  });

  it("does not check again when the branch already holds main", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    const recheck = vi.fn<(head: string) => Promise<RecheckResult>>();
    await land(gh, pr, { recheck });
    expect(recheck).not.toHaveBeenCalled();
    expect(gh.updates).toEqual([]);
  });

  it("refuses when the checks fail on the updated head", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    gh.commit("main", "README.md", "moved\n");
    const err = await refusal(
      land(gh, pr, { recheck: async () => ({ ok: false, checks: [] }) }),
    );
    expect(err).toMatchObject({ reason: "checks_failed" });
    expect(gh.stamps).toEqual([]);
    expect(gh.merges).toEqual([]);
  });

  it("reads the approvals again after the update and records the ones that stand", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    gh.commit("main", "README.md", "moved\n");
    const approve = vi
      .fn<() => Promise<MergeApproval>>()
      .mockResolvedValueOnce({ approvedBy: [REVIEWER], withoutReview: false })
      .mockResolvedValueOnce({
        approvedBy: [REVIEWER, MEMBER],
        withoutReview: false,
      });
    await land(gh, pr, { approve });

    expect(approve).toHaveBeenCalledTimes(2);
    expect((await ledgerLines(gh)).at(-1)).toMatchObject({
      approved_by: [REVIEWER, MEMBER],
    });
    expect(gh.merges[0]!.commitMessage).toContain(
      `Oxagen-Approved-By: ${REVIEWER}, ${MEMBER}`,
    );
  });

  it("refuses when the approval is withdrawn while the branch is brought up to date", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    gh.approvals = [{ userId: REVIEWER, login: "reviewer", commitSha: pr.head }];
    gh.commit("main", "README.md", "moved\n");
    const approve = () =>
      mergeApproval({
        host: gh,
        repo: REPO,
        number: pr.number,
        mode: "team",
        checkedHead: pr.head,
        authorUserId: AUTHOR,
        merger: { userId: MEMBER, orgRole: null, workspaceRole: "Member" },
        isMember: async () => true,
        holdsMergeWithoutReview: async () => false,
      });
    const err = await refusal(
      land(gh, pr, {
        approve,
        recheck: async () => {
          gh.approvals = [];
          return { ok: true, checks: CHECKS };
        },
      }),
    );

    expect(err).toMatchObject({ reason: "approval_required" });
    expect(gh.updates).toHaveLength(1);
    expect(gh.stamps).toEqual([]);
    expect(gh.merges).toEqual([]);
  });

  it("drops the stamp and starts over when main moves after the stamp", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    let moved = false;
    gh.onCommitFiles = () => {
      if (moved) return;
      moved = true;
      gh.commit("main", "README.md", "moved\n");
    };
    const rechecked: string[] = [];
    const landed = await land(gh, pr, {
      recheck: async (head) => {
        rechecked.push(head);
        return { ok: true, checks: CHECKS };
      },
    });

    expect(gh.resets).toEqual([{ branch: pr.branch, sha: pr.head }]);
    expect(gh.updates).toEqual([
      { branch: pr.branch, from: pr.head, to: expect.any(String) },
    ]);
    const updated = gh.updates[0]!.to;
    expect(rechecked).toEqual([updated]);
    expect(gh.stamps).toHaveLength(2);
    expect(gh.stamps[1]!.parent).toBe(updated);
    expect(gh.merges[0]!.sha).toBe(gh.stamps[1]!.sha);
    expect(landed).toMatchObject({ attempts: 2, checkedHead: updated });
    // One ledger line, not two: the dropped stamp never reached main.
    expect(ledgerChainBreaks(await ledgerLines(gh), null, 1)).toEqual([]);
    expect(await ledgerLines(gh)).toHaveLength(21);
  });

  it("gives up when main keeps moving", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    let n = 0;
    gh.onCommitFiles = () => {
      n += 1;
      gh.commit("main", "README.md", `moved ${n}\n`);
    };
    const err = await refusal(land(gh, pr));
    expect(err).toMatchObject({ reason: "production_branch_moving" });
    expect(gh.stamps).toHaveLength(3);
    expect(gh.resets).toHaveLength(3);
    expect(gh.merges).toEqual([]);
  });
});

describe("landSteeringPr: a refused merge", () => {
  it("drops the stamp so a retry starts from the author's head", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    gh.mergeRefusedWith = "GitHub API error 405: Required status check is expected";
    const err = await refusal(land(gh, pr));
    expect(err).toMatchObject({ reason: "github_refused" });
    expect(gh.resets).toEqual([{ branch: pr.branch, sha: pr.head }]);
    expect(await gh.branchHead(REPO, pr.branch)).toBe(pr.head);
  });

  it("drops the stamp when a step between the stamp and the merge fails", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    gh.reportCheckRun = vi
      .fn()
      .mockRejectedValue(new Error("GitHub API error 502: Bad Gateway"));
    await expect(land(gh, pr)).rejects.toThrow("502");
    expect(gh.stamps).toHaveLength(1);
    expect(gh.resets).toEqual([{ branch: pr.branch, sha: pr.head }]);
    expect(await gh.branchHead(REPO, pr.branch)).toBe(pr.head);
    expect(gh.merges).toEqual([]);
  });

  it("still answers the merge's refusal when the stamp cannot be dropped", async () => {
    const gh = steeringRepo();
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    gh.mergeRefusedWith = "GitHub API error 405: Required status check is expected";
    gh.resetBranch = vi.fn().mockRejectedValue(new Error("reset refused"));
    const err = await refusal(land(gh, pr));
    expect(err).toMatchObject({ reason: "github_refused" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ branch: pr.branch, head: pr.head }),
      expect.stringContaining("could not be dropped"),
    );
  });
});

describe("the merge queue, end to end", () => {
  it("merges queued PRs in order, re-checks each after main moves, and skips a refused one", async () => {
    const gh = steeringRepo();
    const prs = [
      await openPr(gh, "a-intel.platform.release-notes"),
      await openPr(gh, "a-intel.platform.review-dates"),
      await openPr(gh, "a-intel.platform.log-levels"),
    ];
    const order: string[] = [];
    const rechecked: number[] = [];
    const results = await Promise.allSettled(
      prs.map((pr) =>
        inMergeQueue(REPO, async () => {
          order.push(`start #${pr.number}`);
          try {
            return await land(gh, pr, {
              recheck: async () => {
                rechecked.push(pr.number);
                // The second PR fails its checks once main holds the first.
                return pr === prs[1]
                  ? { ok: false, checks: [] }
                  : { ok: true, checks: CHECKS };
              },
            });
          } finally {
            order.push(`end #${pr.number}`);
          }
        }),
      ),
    );

    const [a, b, c] = prs.map((pr) => pr.number);
    expect(order).toEqual([
      `start #${a}`,
      `end #${a}`,
      `start #${b}`,
      `end #${b}`,
      `start #${c}`,
      `end #${c}`,
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(rechecked).toEqual([b, c]);
    expect(gh.merges.map((m) => m.number)).toEqual([a, c]);

    const lines = await ledgerLines(gh);
    expect(ledgerChainBreaks(lines, null, 1)).toEqual([]);
    expect(lines.slice(-2).map((l) => [l.seq, l.pull_request.number])).toEqual([
      [21, a],
      [22, c],
    ]);
  });
});

describe("recordPublishDeployment", () => {
  it("records the publish as a deployment to the steering environment", async () => {
    const gh = steeringRepo();
    await expect(
      recordPublishDeployment(gh, REPO, { sha: "merge520", version: 21, number: 520 }),
    ).resolves.toBe("https://github.com/a-intel/platform/deployments/steering");
    expect(gh.deployments).toEqual([
      {
        sha: "merge520",
        ref: "main",
        environment: "steering",
        description: "Steering version 21 from #520",
      },
    ]);
  });

  it("logs a refused deployment instead of failing the publish", async () => {
    const gh = steeringRepo();
    gh.deploymentRefused = true;
    await expect(
      recordPublishDeployment(gh, REPO, { sha: "merge520", version: 21, number: 520 }),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "merge520", pr: 520 }),
      expect.stringContaining("refused the deployment record"),
    );
  });
});

describe("openRevertPr", () => {
  it("opens a steering PR that removes a record the merge added and keeps the ledger", async () => {
    const gh = steeringRepo();
    const before = (await gh.branchHead(REPO, "main"))!;
    const pr = await openPr(gh, "a-intel.platform.release-notes");
    const landed = await land(gh, pr);
    const ledger = await gh.readFile(REPO, LEDGER, "main");

    const revert = await openRevertPr({
      host: gh,
      repo: REPO,
      number: pr.number,
      mergeCommit: landed.commitSha,
      before,
      branch: pr.branch,
    });

    expect(revert.branch).toBe(`steering/revert-${pr.number}`);
    expect(gh.pulls.at(-1)).toMatchObject({
      number: revert.number,
      head: revert.branch,
      base: "main",
      title: `Revert steering PR #${pr.number}`,
    });
    expect(await gh.changedFiles(REPO, "main", revert.branch)).toEqual([
      { path: pr.path, status: "removed" },
    ]);
    expect(await gh.readFile(REPO, LEDGER, revert.branch)).toBe(ledger);
  });

  it("puts a changed record back as it was", async () => {
    const gh = steeringRepo();
    const lineage = "a-intel.platform.headings-sentence-case";
    const path = recordPath(lineage);
    const old = (await gh.readFile(REPO, path, "main"))!;
    const before = (await gh.branchHead(REPO, "main"))!;
    const pr = await openPr(
      gh,
      lineage,
      old.replace("Write every heading", "Write each heading"),
      path,
    );
    const landed = await land(gh, pr);

    const revert = await openRevertPr({
      host: gh,
      repo: REPO,
      number: pr.number,
      mergeCommit: landed.commitSha,
      before,
      branch: pr.branch,
    });
    expect(await gh.readFile(REPO, path, revert.branch)).toBe(old);
    expect(await gh.changedFiles(REPO, "main", revert.branch)).toEqual([
      { path, status: "modified" },
    ]);
  });

  it("refuses a merge that changed nothing", async () => {
    const gh = steeringRepo();
    const main = (await gh.branchHead(REPO, "main"))!;
    await expect(
      refusal(
        openRevertPr({
          host: gh,
          repo: REPO,
          number: 7,
          mergeCommit: main,
          before: main,
          branch: "steering/a-intel.platform.release-notes",
        }),
      ),
    ).resolves.toMatchObject({ reason: "nothing_to_revert" });
  });
});
