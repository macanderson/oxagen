/**
 * restore_managed_block (#4518) over the steering test harness: a steering
 * repo whose production branch holds the files Oxagen writes first, an open
 * steering PR, and a push to its branch that edits the managed block in
 * AGENTS.md. The IAM reads are replaced, and the contract's role check is a
 * spy.
 */
import { HandlerError } from "@oxagen/oxagen";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { steeringPrRestoreManagedBlock } from "@oxagen/oxagen/contracts/steering.pr.restore_managed_block";
import {
  agentsMdTemplate,
  claudeMdTemplate,
  governanceTomlTemplate,
  readManagedBlock,
} from "@oxagen/oxagen/steering-repo/templates";
import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async (actor: { userId: string | null }) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    return "Member";
  },
}));

import { createGetSteeringPrHandler } from "./steering.pr.get";
import { createOpenSteeringPrHandler } from "./steering.pr.open";
import { createRestoreManagedBlockHandler } from "./steering.pr.restore_managed_block";
import { createProposeRecordHandler } from "./steering.proposal.create";
import { ctx, harness, type Harness } from "./context.steering.test-support";

const AGENTS = agentsMdTemplate({
  provider: "github",
  organization: "a-intel",
  repository: "a-intel/platform",
  scope: { kind: "workspace", slug: "platform", label: "Platform" },
});

/** A steering repo: governance.toml, AGENTS.md, and CLAUDE.md on main. */
function steeringRepo(): Harness {
  return harness({
    "main:steering/governance.toml": governanceTomlTemplate(),
    "main:AGENTS.md": AGENTS,
    "main:CLAUDE.md": claudeMdTemplate(),
  });
}

/** A proposal with its steering PR open. Answers the proposal and its branch. */
async function opened(h: Harness): Promise<{ proposalId: string; branch: string }> {
  const { proposalId } = await createProposeRecordHandler(h)(
    steeringProposalCreate.input.parse({
      record: {
        lineageId: "a-intel.platform.release-notes",
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: "Write the release notes before you tag a release.",
      },
      rationale: "Three releases shipped with no notes.",
    }),
    ctx(),
  );
  await createOpenSteeringPrHandler(h)({ proposalId }, ctx());
  const branch = h.store.proposals[0]?.branch;
  if (!branch) throw new Error("the PR did not open");
  return { proposalId, branch };
}

function restore(h: Harness) {
  const assertRole = vi.fn(async () => undefined);
  return { handler: createRestoreManagedBlockHandler({ ...h, assertRole }), assertRole };
}

async function refusal(run: Promise<unknown>): Promise<HandlerError> {
  try {
    await run;
  } catch (err) {
    return err as HandlerError;
  }
  throw new Error("The restore went through, and the test expected a refusal.");
}

describe("restore_managed_block", () => {
  it("commits the production block on the PR's branch, keeps the notes, and runs the checks on that commit", async () => {
    const h = steeringRepo();
    const { proposalId, branch } = await opened(h);
    const edited = `${AGENTS.replace("Run `oxagen check` before you push.", "Push to main.")}- A note from the team.\n`;
    const pushed = h.github.commit(branch, "AGENTS.md", edited, "edit AGENTS.md");
    const { handler, assertRole } = restore(h);

    const out = await handler(
      steeringPrRestoreManagedBlock.input.parse({ proposalId, path: "AGENTS.md" }),
      ctx(),
    );

    expect(assertRole).toHaveBeenCalledTimes(1);
    const stamp = h.github.stamps.at(-1);
    expect(stamp).toMatchObject({
      branch,
      parent: pushed,
      sha: out.commit_sha,
      message: "steering: restore the managed block in AGENTS.md",
    });
    const restored = await h.github.readFile(h.github.repository!, "AGENTS.md", out.commit_sha);
    expect(restored).toBe(`${AGENTS}- A note from the team.\n`);
    const block = readManagedBlock(restored ?? "");
    expect(block.ok && block.block?.intact).toBe(true);

    // The proposal now describes the restored head, and the checks ran on it.
    const row = h.store.proposals[0];
    expect(row?.headSha).toBe(out.commit_sha);
    expect(row?.status).toBe(out.status);
    expect(["checks_passed", "checks_failed"]).toContain(out.status);
    expect(h.github.checkRuns.some((run) => run.headSha === out.commit_sha)).toBe(true);
  });

  it("refuses a block that already matches the production branch, and writes nothing (negative)", async () => {
    const h = steeringRepo();
    const { proposalId } = await opened(h);
    const stamps = h.github.stamps.length;
    const err = await refusal(
      restore(h).handler({ proposalId, path: "AGENTS.md" }, ctx()),
    );
    expect(err).toMatchObject({ code: "conflict", reason: "block_intact" });
    expect(err.message).toContain("already matches main");
    expect(h.github.stamps).toHaveLength(stamps);
  });

  it("refuses a file the production branch holds no block in (negative)", async () => {
    const h = steeringRepo();
    const { proposalId, branch } = await opened(h);
    h.github.commit(branch, "README.md", "# Platform\n");
    await expect(
      restore(h).handler({ proposalId, path: "README.md" }, ctx()),
    ).rejects.toMatchObject({ reason: "no_managed_block" });
  });

  it("refuses a repository that keeps the legacy layout (negative)", async () => {
    const h = harness();
    const { proposalId } = await opened(h);
    await expect(
      restore(h).handler({ proposalId, path: "AGENTS.md" }, ctx()),
    ).rejects.toMatchObject({ reason: "no_managed_blocks" });
  });

  it("refuses a proposal whose PR is not open yet, and one that is gone (negative)", async () => {
    const h = steeringRepo();
    const { proposalId } = await createProposeRecordHandler(h)(
      steeringProposalCreate.input.parse({
        record: {
          lineageId: "a-intel.platform.tag-after-smoke",
          kind: "rule",
          force: "should",
          sharingScope: "workspace",
          statement: "Tag a release only after the staging smoke test passes.",
        },
        rationale: "A tag went out before the smoke test.",
      }),
      ctx(),
    );
    const { handler } = restore(h);
    await expect(handler({ proposalId, path: "AGENTS.md" }, ctx())).rejects.toMatchObject({
      reason: "pr_not_open",
    });
    await expect(
      handler({ proposalId: "prp_missing1", path: "AGENTS.md" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found", reason: "proposal_not_found" });
  });

  it("writes nothing for a caller the role check refuses (negative)", async () => {
    const h = steeringRepo();
    const { proposalId, branch } = await opened(h);
    h.github.commit(branch, "AGENTS.md", "edited\n");
    const { handler, assertRole } = restore(h);
    assertRole.mockRejectedValueOnce(
      new HandlerError({ code: "forbidden", reason: "role_not_held" }),
    );
    const stamps = h.github.stamps.length;
    await expect(handler({ proposalId, path: "AGENTS.md" }, ctx())).rejects.toMatchObject({
      reason: "role_not_held",
    });
    expect(h.github.stamps).toHaveLength(stamps);
  });
});

describe("the managed-block findings a check run stores (#4518 item 7)", () => {
  it("stores the drifted block when the checks run, answers it from get_steering_pr, and clears it once Restore block runs", async () => {
    const h = steeringRepo();
    const { proposalId, branch } = await opened(h);
    const get = createGetSteeringPrHandler(h);
    expect((await get({ proposalId }, ctx())).findings).toEqual([]);

    const edited = `${AGENTS.replace("Run `oxagen check` before you push.", "Push to main.")}- A note from the team.\n`;
    h.github.commit(branch, "AGENTS.md", edited, "edit AGENTS.md");
    await createOpenSteeringPrHandler(h)({ proposalId }, ctx());

    const drifted = await get({ proposalId }, ctx());
    expect(drifted.findings).toEqual([
      {
        rule: "managed-block",
        path: "AGENTS.md",
        line: expect.any(Number),
        message: "The managed block in AGENTS.md was edited.",
      },
    ]);

    await restore(h).handler({ proposalId, path: "AGENTS.md" }, ctx());
    // AGENTS.md still differs from main by the team's note, but its block
    // matches main again, so the run that checked the restore stores none.
    expect((await get({ proposalId }, ctx())).findings).toEqual([]);
  });

  it("stores nothing for a file the PR changes outside the block (negative)", async () => {
    const h = steeringRepo();
    const { proposalId, branch } = await opened(h);
    h.github.commit(branch, "AGENTS.md", `${AGENTS}- A note from the team.\n`);
    await createOpenSteeringPrHandler(h)({ proposalId }, ctx());
    expect(
      (await createGetSteeringPrHandler(h)({ proposalId }, ctx())).findings,
    ).toEqual([]);
  });

  it("stores no findings when the host refuses the read, and the checks still finish (negative)", async () => {
    const h = steeringRepo();
    const { proposalId, branch } = await opened(h);
    h.github.commit(branch, "AGENTS.md", "edited\n");
    const read = h.github.readFile.bind(h.github);
    h.github.readFile = async (repo, path, ref) => {
      if (path === "AGENTS.md") throw new Error("502 from the host");
      return read(repo, path, ref);
    };
    await createOpenSteeringPrHandler(h)({ proposalId }, ctx());
    const row = h.store.proposals[0];
    expect(["checks_passed", "checks_failed"]).toContain(row?.status);
    expect(row?.checkFindings).toEqual([]);
  });
});
