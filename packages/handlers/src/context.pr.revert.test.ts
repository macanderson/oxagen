import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import type { GovernanceMode } from "@oxagen/oxagen/contracts/context.steering.shared";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";

// The role gate reads iam.principal_role_assignments and the key's creator
// from auth.api_keys; the tests decide both.
const gate = vi.hoisted(() => ({
  refuse: false,
  keyCreator: null as string | null,
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: {
    userId: string | null;
    apiKeyId: string | null;
  }) => c.userId ?? (c.apiKeyId ? gate.keyCreator : null),
  assertOrgRole: async (actor: { userId: string | null }) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    if (gate.refuse)
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Member";
  },
}));

import { createOpenContextPrHandler } from "./context.pr.open";
import { createMergeContextPrHandler } from "./context.pr.merge";
import {
  createRevertSteeringPrHandler,
  type RevertDeps,
} from "./context.pr.revert";
import { createProposeRecordHandler } from "./context.proposal.create";
import {
  AUTHOR,
  REPO,
  REVIEWER,
  SCOPE,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

const LINEAGE = "ctx.release.no-reread-changelog";
const LEGACY_PATH = `.oxagen/rules/${LINEAGE}.toml`;
const BRANCH = `steering/${LINEAGE}`;
const LEDGER = "steering/promotions/2026-09.jsonl";
/** A workspace Owner with no organization role. */
const OWNER = "0192d4a8-7c1e-7a00-8000-0000000005e9";

/** The fixture steering repo on main, with a clock after its ledger's last line. */
function steeringHarness(): Harness {
  const seed: Record<string, string> = {};
  for (const [path, text] of fixtureRepo()) seed[`main:${path}`] = text;
  const h = harness(seed);
  let t = Date.parse("2026-09-26T12:00:00.000Z");
  const clock = () => new Date((t += 1000));
  h.github.clock = clock;
  h.now = clock;
  return h;
}

/** A legacy repository whose governance file declares `mode`. */
function legacyHarness(mode: GovernanceMode): Harness {
  const h = harness({
    "main:.oxagen/rules/governance.toml": `mode = "${mode}"\n`,
  });
  h.roleOf.set(OWNER, { org: null, workspace: "Owner" });
  return h;
}

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
      now: () => new Date("2026-09-27T08:00:00Z"),
    },
  };
  return createRevertSteeringPrHandler(deps);
}

const proposalInput = () =>
  contextProposalCreate.input.parse({
    record: {
      lineageId: LINEAGE,
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      statement:
        "Do not re-read CHANGELOG.md more than once in a run; cache the first read.",
    },
    rationale: "682 duplicate tool calls across 212 runs.",
  });

/** Propose the record and open its steering PR, as an author does. */
async function opened(h: Harness): Promise<string> {
  const { proposalId } = await createProposeRecordHandler(h)(
    proposalInput(),
    ctx(),
  );
  await createOpenContextPrHandler(h)({ proposalId }, ctx());
  return proposalId;
}

/**
 * A steering PR that added LEGACY_PATH, merged on the host, and its proposal
 * recorded as merged. It skips the merge's own rules, so a test can set the
 * governance mode the revert reads without meeting them first.
 */
async function mergedOnHost(
  h: Harness,
  over: { kind?: string; mergedCommit?: string } = {},
) {
  await h.github.ensureBranch(REPO, BRANCH, REPO.defaultBranch);
  const head = h.github.commit(BRANCH, LEGACY_PATH, 'set_id = "a-intel.platform"\n');
  const { number, htmlUrl } = await h.github.openPullRequest(REPO, {
    title: LINEAGE,
    head: BRANCH,
    base: REPO.defaultBranch,
    body: "",
  });
  const { sha } = await h.github.mergePullRequest(REPO, {
    number,
    commitTitle: `steering: publish ${LINEAGE} (#${number})`,
    sha: head,
  });
  const row = await h.store.insertProposal({
    orgId: SCOPE.orgId,
    workspaceId: SCOPE.workspaceId,
    lineageId: LINEAGE,
    kind: over.kind ?? "rule",
    force: "should",
    constraintEffect: null,
    sharingScope: "workspace",
    statement: "Do not re-read CHANGELOG.md more than once in a run.",
    rationale: "682 duplicate tool calls.",
    source: "test",
    supportRuns: [],
    supportAgents: [],
    supportingRecordIds: [],
    evidenceLinks: [],
    createdById: AUTHOR,
    status: "merged",
    provider: "github",
    repository: REPO.fullName,
    baseRef: REPO.defaultBranch,
    branch: BRANCH,
    path: LEGACY_PATH,
    prNumber: number,
    prUrl: htmlUrl,
    headSha: head,
  });
  row.mergedCommit = over.mergedCommit ?? sha;
  return { proposalId: row.publicId, number, mergedCommit: sha };
}

beforeEach(() => {
  gate.refuse = false;
  gate.keyCreator = null;
});

describe("revert_steering_pr", () => {
  it("opens a steering PR that removes the record a merge added, leaves the ledger, and reports the required check", async () => {
    const h = steeringHarness();
    const proposalId = await opened(h);
    const merged = await createMergeContextPrHandler(h)(
      { proposalId },
      ctx({ userId: REVIEWER }),
    );
    const recordAt = `steering/business-rules/${LINEAGE}.md`;
    const ledger = await h.github.readFile(REPO, LEDGER, "main");
    expect(await h.github.readFile(REPO, recordAt, "main")).not.toBeNull();

    const out = await revert(h)({ proposalId }, ctx({ userId: REVIEWER }));

    expect(out).toMatchObject({
      proposalId,
      reverted: { number: 519, mergedCommit: merged.mergedCommit },
      pullRequest: {
        number: 520,
        url: "https://github.com/a-intel/platform/pull/520",
        branch: "steering/revert-519",
      },
    });
    expect(h.github.pulls.at(-1)).toMatchObject({
      number: 520,
      head: "steering/revert-519",
      base: "main",
      title: "Revert steering PR #519",
      state: "open",
    });
    expect(
      await h.github.changedFiles(REPO, "main", "steering/revert-519"),
    ).toEqual([{ path: recordAt, status: "removed" }]);
    expect(await h.github.readFile(REPO, LEDGER, "steering/revert-519")).toBe(
      ledger,
    );
    // The required check runs on the revert's head, and the answer names it.
    const head = await h.github.branchHead(REPO, "steering/revert-519");
    expect(out.pullRequest.headSha).toBe(head);
    const reported = h.github.checkRuns.at(-1);
    expect(reported).toMatchObject({ name: "Oxagen steering", headSha: head });
    expect(out.check).toBe(reported?.conclusion);
    // Nothing merged: the revert waits for its own review.
    expect(h.github.merges).toHaveLength(1);
  });

  it("in a legacy repository, opens the revert and reports no check", async () => {
    const h = legacyHarness("solo");
    const proposalId = await opened(h);
    await createMergeContextPrHandler(h)({ proposalId }, ctx());
    const checksBefore = h.github.checkRuns.length;

    const out = await revert(h)({ proposalId }, ctx());

    expect(out.check).toBeNull();
    expect(out.pullRequest.branch).toBe("steering/revert-519");
    expect(
      await h.github.changedFiles(REPO, "main", "steering/revert-519"),
    ).toEqual([{ path: LEGACY_PATH, status: "removed" }]);
    expect(h.github.checkRuns).toHaveLength(checksBefore);
  });

  it("refuses a proposal that is not merged, and opens nothing", async () => {
    const h = legacyHarness("solo");
    const proposalId = await opened(h);
    const pulls = h.github.pulls.length;

    await expect(revert(h)({ proposalId }, ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "not_merged",
    });
    expect(h.github.pulls).toHaveLength(pulls);
    expect(h.github.heads.has("steering/revert-519")).toBe(false);
  });

  it("refuses a caller without the contract's role before it reads anything", async () => {
    const h = legacyHarness("solo");
    const { proposalId } = await mergedOnHost(h);
    gate.refuse = true;
    const find = vi.spyOn(h.store, "findProposal");

    await expect(revert(h)({ proposalId }, ctx())).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(find).not.toHaveBeenCalled();
    expect(h.github.pulls).toHaveLength(1);
  });

  it("refuses an API key whose creator is gone", async () => {
    const h = legacyHarness("solo");
    const { proposalId } = await mergedOnHost(h);

    await expect(
      revert(h)({ proposalId }, ctx({ userId: null, apiKeyId: "key_1" })),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
  });

  it("acts for an API key's creator, so MCP and the CLI can revert", async () => {
    const h = legacyHarness("team");
    const { proposalId } = await mergedOnHost(h);
    gate.keyCreator = REVIEWER;

    const out = await revert(h)(
      { proposalId },
      ctx({ userId: null, apiKeyId: "key_1", surface: "mcp" }),
    );
    expect(out.pullRequest.branch).toBe("steering/revert-519");
  });

  describe("the governance mode's merge rule", () => {
    const cases: {
      mode: GovernanceMode;
      who: string;
      user: string;
      outcome: "opens" | "org_role_required";
    }[] = [
      { mode: "solo", who: "a workspace Member", user: AUTHOR, outcome: "opens" },
      { mode: "team", who: "a workspace Member", user: AUTHOR, outcome: "org_role_required" },
      { mode: "team", who: "a workspace Owner", user: OWNER, outcome: "opens" },
      { mode: "team", who: "an org Admin", user: REVIEWER, outcome: "opens" },
      { mode: "regulated", who: "a workspace Owner", user: OWNER, outcome: "org_role_required" },
      { mode: "regulated", who: "an org Admin", user: REVIEWER, outcome: "opens" },
    ];
    for (const { mode, who, user, outcome } of cases) {
      it(`${mode}: ${who} ${outcome === "opens" ? "opens the revert" : "is refused"}`, async () => {
        const h = legacyHarness(mode);
        const { proposalId, number } = await mergedOnHost(h);
        const call = revert(h)({ proposalId }, ctx({ userId: user }));
        if (outcome === "opens") {
          await expect(call).resolves.toMatchObject({
            reverted: { number },
            pullRequest: { branch: `steering/revert-${number}` },
          });
        } else {
          await expect(call).rejects.toMatchObject({
            code: "forbidden",
            reason: outcome,
          });
          expect(h.github.heads.has(`steering/revert-${number}`)).toBe(false);
        }
      });
    }

    it("never applies separation of duties: the author may revert their own merged PR", async () => {
      const h = legacyHarness("team");
      h.roleOf.set(AUTHOR, { org: "Admin", workspace: null });
      const { proposalId } = await mergedOnHost(h);
      await expect(
        revert(h)({ proposalId }, ctx({ userId: AUTHOR })),
      ).resolves.toMatchObject({ pullRequest: { number: 520 } });
    });
  });

  it("refuses a governance change and points at setting the mode again", async () => {
    const h = legacyHarness("solo");
    const { proposalId } = await mergedOnHost(h, { kind: "governance" });

    await expect(revert(h)({ proposalId }, ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "governance_proposal",
      message: expect.stringContaining("Set the mode again"),
    });
  });

  it("refuses a proposal this workspace does not have", async () => {
    const h = legacyHarness("solo");
    await expect(
      revert(h)({ proposalId: "prp_missing" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found", reason: "proposal_not_found" });
  });

  it("refuses a merge commit with no parent", async () => {
    const h = legacyHarness("solo");
    // base0 is the fake host's first commit on main, so it has no parent.
    const { proposalId } = await mergedOnHost(h, { mergedCommit: "base0" });

    await expect(revert(h)({ proposalId }, ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "merge_commit_unknown",
    });
  });

  it("refuses a second revert while the first one's branch exists", async () => {
    const h = legacyHarness("solo");
    const { proposalId, number } = await mergedOnHost(h);
    await revert(h)({ proposalId }, ctx());

    await expect(revert(h)({ proposalId }, ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "revert_branch_exists",
      message: expect.stringContaining(`#${number}`),
    });
    expect(h.github.pulls.filter((p) => p.title.startsWith("Revert"))).toHaveLength(1);
  });
});
