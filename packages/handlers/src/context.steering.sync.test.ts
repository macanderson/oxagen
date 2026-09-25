/**
 * The repository sync (ADR-182) end to end, over the in-memory registry and a
 * fake GitHub with commits: a push, a merge on GitHub, a rename, a deletion
 * and a broken file each leave the registry matching the production branch,
 * and each problem reaches the sync state and the commit's check.
 *
 * The Context PR cases run the real open and merge handlers against the same
 * registry, so they show the two paths agree: a merge from Oxagen and the sync
 * its push triggers publish one version, not two.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";

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

import { createOpenContextPrHandler } from "./context.pr.open";
import { createMergeContextPrHandler } from "./context.pr.merge";
import { createProposeRecordHandler } from "./context.proposal.create";
import { syncView } from "./context.steering.freshness";
import { buildRecordFile, serializeRecordFile } from "./context.steering.file";
import {
  MERGE_GRACE_SECONDS,
  SYNC_CHECK_NAME,
  syncWorkspaceSteering,
  type SyncDeps,
} from "./context.steering.sync";
import {
  MemorySyncStore,
  REVIEWER,
  SCOPE,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

const RULES = ".oxagen/rules";

function recordText(lineageId: string, statement = `Follow ${lineageId}.`) {
  return serializeRecordFile(
    buildRecordFile({
      lineageId,
      label: "A label",
      kind: "rule",
      force: "must",
      sharingScope: "workspace",
      statement,
      origin: "user",
      proposalPublicId: "prp_seed",
      setId: "a-intel.platform",
    }),
  );
}

interface Rig {
  h: Harness;
  sync: MemorySyncStore;
  deps: SyncDeps;
  run: (force?: boolean) => ReturnType<typeof syncWorkspaceSteering>;
}

function rig(files: Record<string, string> = {}): Rig {
  const h = harness(files);
  const sync = new MemorySyncStore(h.store);
  const deps: SyncDeps = {
    github: h.github,
    store: sync,
    steering: h.store,
    now: h.now,
  };
  // The merge handler asks for a sync when it finds a PR merged on the host,
  // as `steeringDeps()` wires it in production. The request is recorded
  // here, and a test runs the sync itself the way the queue would.
  h.requestSync = vi.fn(async () => undefined);
  return {
    h,
    sync,
    deps,
    run: (force = false) => syncWorkspaceSteering(deps, SCOPE, { force }),
  };
}

const active = (r: Rig) =>
  r.h.store.records.filter((x) => x.status === "active");

describe("syncWorkspaceSteering", () => {
  it("publishes every record file on the production branch", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    r.h.github.commit(
      "main",
      `${RULES}/team/two.toml`,
      recordText("ctx.a.two"),
    );
    const out = await r.run();
    expect(out.outcome).toBe("synced");
    expect(out.created).toBe(2);
    expect(
      active(r)
        .map((x) => [x.slug, x.path])
        .sort(),
    ).toEqual([
      ["ctx.a.one", `${RULES}/ctx.a.one.toml`],
      ["ctx.a.two", `${RULES}/team/two.toml`],
    ]);
    expect(r.sync.state).toMatchObject({
      status: "synced",
      headSha: r.h.github.heads.get("main"),
      findings: [],
    });
    expect(r.h.github.checkRuns).toEqual([
      expect.objectContaining({
        name: SYNC_CHECK_NAME,
        conclusion: "success",
        headSha: r.h.github.heads.get("main"),
      }),
    ]);
  });

  it("reads nothing more when the branch head has not moved", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    await r.run();
    const listFiles = vi.spyOn(r.h.github, "listFiles");
    const out = await r.run();
    expect(out.outcome).toBe("current");
    expect(listFiles).not.toHaveBeenCalled();
    expect(r.sync.applied).toBe(1);
    // One check per head: the second run posts nothing new.
    expect(r.h.github.checkRuns).toHaveLength(1);
  });

  it("keeps a record's id and versions when its file is renamed on the branch", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    await r.run();
    const [before] = active(r);
    r.h.github.rename(
      "main",
      `${RULES}/ctx.a.one.toml`,
      `${RULES}/team/one.toml`,
    );
    const out = await r.run();
    expect(out).toMatchObject({
      created: 0,
      revised: 0,
      updated: 1,
      retired: 0,
    });
    const [after] = active(r);
    expect(after?.id).toBe(before?.id);
    expect(after?.path).toBe(`${RULES}/team/one.toml`);
    expect(r.h.store.versions).toHaveLength(1);
  });

  it("publishes a direct push that changes a statement", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    await r.run();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one", "Follow it twice."),
    );
    const out = await r.run();
    expect(out.revised).toBe(1);
    expect(active(r)[0]?.statement).toBe("Follow it twice.");
    expect(r.h.store.versions.map((v) => v.version)).toEqual([1, 2]);
    // A sync's publication names no approver; the ledger says it came from
    // the repository.
    expect(r.h.store.ledger.map((l) => l.policyVersion)).toEqual([
      "repository:sync",
      "repository:sync",
    ]);
  });

  it("retires a record whose file was deleted on the branch", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    await r.run();
    const removal = r.h.github.remove("main", `${RULES}/ctx.a.one.toml`);
    const out = await r.run();
    expect(out.retired).toBe(1);
    expect(active(r)).toEqual([]);
    expect(r.h.store.ledger.at(-1)).toMatchObject({ action: "retire" });
    // A checkout that still holds the deleted file is behind: the freshness
    // read names the commit that removed it.
    expect(r.h.store.records[0]?.commitSha).toBe(removal);
  });

  it("reports a broken file on the page and the commit, and keeps the record in force", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    await r.run();
    r.h.github.commit("main", `${RULES}/ctx.a.one.toml`, "schema = [broken");
    const out = await r.run();
    expect(out.outcome).toBe("problems");
    expect(active(r)).toHaveLength(1);
    expect(r.sync.state?.status).toBe("problems");
    expect(r.sync.state?.findings).toEqual([
      expect.objectContaining({ level: "error", code: "not_toml" }),
    ]);
    expect(r.h.github.checkRuns.at(-1)).toMatchObject({
      name: SYNC_CHECK_NAME,
      conclusion: "failure",
    });
  });

  // Most pushes to main never touch `.oxagen/rules/`. They must not list the
  // rules or post a check: the newest commit that changed the rules is the
  // one the last sync read.
  it("lists nothing more when a push leaves the rules alone", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    await r.run();
    const rulesSha = r.sync.state?.rulesSha;
    r.h.github.commit("main", "src/index.ts", "export {};\n");
    const listFiles = vi.spyOn(r.h.github, "listFiles");
    const out = await r.run();
    expect(out.outcome).toBe("current");
    expect(listFiles).not.toHaveBeenCalled();
    expect(r.sync.state).toMatchObject({
      headSha: r.h.github.heads.get("main"),
      rulesSha,
    });
    expect(r.h.github.checkRuns).toHaveLength(1);
  });

  // A file the tree listed that then reads back empty is a failed read.
  // Planning without it would retire its record, so the sync stops.
  it("stops rather than plan a tree it could not read in full", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    await r.run();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.two.toml`,
      recordText("ctx.a.two"),
    );
    vi.spyOn(r.h.github, "readFile").mockResolvedValue(null);
    await expect(r.run()).rejects.toThrow("could not read");
    expect(active(r)).toHaveLength(1);
    expect(r.sync.state?.status).toBe("failed");
  });

  it("records a failure and keeps the last good head when the branch is gone", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    await r.run();
    const good = r.sync.state?.headSha;
    r.h.github.heads.delete("main");
    await expect(r.run()).rejects.toMatchObject({
      reason: "production_branch_missing",
    });
    expect(r.sync.state).toMatchObject({ status: "failed", headSha: good });
    expect(r.sync.state?.error).toContain("has no branch main");
  });

  it("answers no_repository for a workspace with no main repository", async () => {
    const r = rig();
    r.h.github.repository = null;
    const out = await r.run();
    expect(out.outcome).toBe("no_repository");
    expect(r.sync.state).toBeNull();
  });

  // A webhook stamps the request before the sync finds there is nothing to
  // read: a retired GitHub connection, or a GitLab project that is not the
  // main one. Left unanswered, the stamp reads as pending for good and the
  // page refreshes itself forever.
  it("answers a stamped request even when there is no repository to read", async () => {
    const r = rig();
    r.h.github.repository = null;
    await r.sync.markRequested(SCOPE, r.h.now());
    await r.run();
    expect(syncView(r.sync.state)?.status).toBe("failed");
    expect(r.sync.state?.error).toContain("no main repository");
  });
});

describe("Context PRs on the host", () => {
  const LINEAGE = "ctx.release.no-reread-changelog";

  async function openedAndPassed(r: Rig): Promise<string> {
    const { proposalId } = await createProposeRecordHandler(r.h)(
      contextProposalCreate.input.parse({
        record: {
          lineageId: LINEAGE,
          kind: "rule",
          force: "should",
          sharingScope: "workspace",
          statement: "Do not re-read CHANGELOG.md more than once in a run.",
        },
        rationale: "682 duplicate tool calls across 212 runs.",
        support: { runs: [], agents: [], recordIds: [], evidenceLinks: [] },
      }),
      ctx(),
    );
    await createOpenContextPrHandler(r.h)({ proposalId }, ctx());
    return proposalId;
  }

  const proposal = (r: Rig, publicId: string) =>
    r.h.store.proposals.find((p) => p.publicId === publicId)!;

  // Grace passed: the clock is moved well past the merge before the sync.
  const pastGrace = (r: Rig) => {
    let t = Date.now() + (MERGE_GRACE_SECONDS + 60) * 1000;
    r.deps.now = () => new Date((t += 1000));
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // #4118: the checks passed, a review suggestion then rewrote the statement
  // on the PR branch and left the old record_hash, and someone merged on
  // GitHub. The file on the branch is in force, so the sync publishes it and
  // the proposal reads merged, with a warning about the stale stamp.
  it("publishes a PR merged on GitHub after its head moved, and marks it merged", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    expect(proposal(r, id).status).toBe("checks_passed");
    const path = proposal(r, id).path!;
    const edited = (await r.h.github.readFile(
      r.h.github.repository!,
      path,
      `context/${LINEAGE}`,
    ))!.replace("more than once in a run.", "more than once per run.");
    r.h.github.commit(`context/${LINEAGE}`, path, edited);
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    pastGrace(r);

    const out = await r.run();
    expect(out.proposals.merged).toBe(1);
    const row = proposal(r, id);
    expect(row.status).toBe("merged");
    expect(row.mergedByUserId).toBeNull();
    expect(active(r)[0]?.statement).toBe(
      "Do not re-read CHANGELOG.md more than once per run.",
    );
    expect(r.sync.state?.findings).toEqual([
      expect.objectContaining({ level: "warning", code: "stale_stamp" }),
    ]);
  });

  // The same #4118 sequence reached through the Merge button: the handler
  // runs the sync and answers with what it found instead of telling the
  // person to start over.
  // The same #4118 sequence reached through the Merge button: the handler
  // asks for the sync through its queue and says so, instead of telling the
  // person to start over. The queue's sync then publishes it.
  it("asks for the sync when Merge is pressed on a PR already merged on GitHub", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    const path = proposal(r, id).path!;
    r.h.github.commit(
      `context/${LINEAGE}`,
      path,
      recordText(LINEAGE, "Edited on the PR."),
    );
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    pastGrace(r);
    await expect(
      createMergeContextPrHandler(r.h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({
      reason: "merged_outside_oxagen",
      message: expect.stringContaining("reading the production branch now"),
    });
    expect(r.h.requestSync).toHaveBeenCalledWith(SCOPE);
    await r.run();
    expect(proposal(r, id).status).toBe("merged");
    expect(active(r)[0]?.statement).toBe("Edited on the PR.");
  });

  // A sync's publication and the merge's can land in either order. When the
  // sync's push wins the lock, the merge adds its reviewer to that version
  // rather than writing the same bytes twice.
  it("reuses a version the sync already published when Oxagen's merge lands second", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    // The sync reads the PR as open, then a head that already holds the
    // merge: it publishes the lineage without deferring it.
    const merge = createMergeContextPrHandler(r.h);
    const realGet = r.h.github.getPullRequest.bind(r.h.github);
    const open = await realGet(
      r.h.github.repository!,
      r.h.github.pulls[0]!.number,
    );
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    const spy = vi
      .spyOn(r.h.github, "getPullRequest")
      .mockResolvedValueOnce(open);
    await r.run(true);
    spy.mockRestore();
    expect(r.h.store.versions).toHaveLength(1);
    await merge({ proposalId: id }, ctx({ userId: REVIEWER }));
    expect(r.h.store.versions).toHaveLength(1);
    expect(proposal(r, id)).toMatchObject({
      status: "merged",
      mergedByUserId: REVIEWER,
    });
    expect(r.h.store.ledger.at(-1)?.approverUserId).toBe(REVIEWER);
  });

  // A reviewer on GitHub accepted a suggestion that put a credential into
  // the record, then merged. The sync refuses the file, so the proposal must
  // not read merged: it says why nothing was published.
  it("rejects a PR merged on GitHub whose file the sync refused", async () => {
    const r = rig();
    // The lineage is already in force, so a link would find a record and a
    // promotion to point at: the old version, which is the wrong answer.
    r.h.github.commit(
      "main",
      `${RULES}/${LINEAGE}.toml`,
      recordText(LINEAGE, "The version in force."),
    );
    await r.run();
    const id = await openedAndPassed(r);
    const path = proposal(r, id).path!;
    r.h.github.commit(
      `context/${LINEAGE}`,
      path,
      recordText(LINEAGE, "Push with ghp_0123456789abcdefghijklmnopqrstuvwx."),
    );
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    pastGrace(r);
    const out = await r.run();
    expect(out.proposals).toMatchObject({ merged: 0, rejected: 1 });
    expect(proposal(r, id).status).toBe("rejected");
    expect(proposal(r, id).dismissedReason).toContain(
      "Oxagen could not publish it",
    );
    expect(active(r).map((x) => x.statement)).toEqual([
      "The version in force.",
    ]);
  });

  it("rejects a proposal whose PR was closed on GitHub without merging", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    r.h.github.closeOnHost(r.h.github.pulls[0]!.number);
    const out = await r.run();
    expect(out.proposals.rejected).toBe(1);
    expect(proposal(r, id)).toMatchObject({
      status: "rejected",
      dismissedReason: "Closed on GitHub without merging",
    });
    expect(active(r)).toEqual([]);
    // The next proposal on the lineage branches from main, not from the
    // closed PR's commits.
    expect(r.h.github.deletedBranches).toContain(`context/${LINEAGE}`);
  });

  it("resets the checks when the PR's branch moves on GitHub", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    const path = proposal(r, id).path!;
    const moved = r.h.github.commit(
      `context/${LINEAGE}`,
      path,
      recordText(LINEAGE, "Moved."),
    );
    const out = await r.run();
    expect(out.proposals.stale).toBe(1);
    expect(proposal(r, id)).toMatchObject({
      status: "pr_open",
      headSha: moved,
    });
    expect(proposal(r, id).checks.every((c) => c.status === "pending")).toBe(
      true,
    );
  });

  // A merge Oxagen made is Oxagen's to publish, with its reviewer on the
  // ledger. The sync its push triggers leaves the lineage alone inside the
  // grace window, and after it finds the content already published.
  it("leaves a fresh Oxagen merge to merge_context_pr and publishes it once", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    r.deps.now = () =>
      new Date(r.h.github.pulls[0]!.mergedAt!.getTime() + 5000);

    const early = await r.run();
    expect(early.retryAfterSeconds).toBe(MERGE_GRACE_SECONDS);
    expect(active(r)).toEqual([]);
    expect(proposal(r, id).status).toBe("checks_passed");

    await createMergeContextPrHandler(r.h)(
      { proposalId: id },
      ctx({ userId: REVIEWER }),
    );
    expect(proposal(r, id).mergedByUserId).toBe(REVIEWER);

    pastGrace(r);
    const late = await r.run(true);
    expect(late.revised + late.created).toBe(0);
    expect(r.h.store.versions).toHaveLength(1);
    expect(r.h.store.ledger).toHaveLength(1);
    expect(r.h.store.ledger[0]?.approverUserId).toBe(REVIEWER);
  });

  it("publishes a PR merged on GitHub at the checked head once the grace passes", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    pastGrace(r);
    const out = await r.run();
    expect(out.proposals.merged).toBe(1);
    expect(proposal(r, id)).toMatchObject({
      status: "merged",
      mergedByUserId: null,
    });
    expect(r.h.store.versions).toHaveLength(1);
    expect(r.h.github.deletedBranches).toContain(`context/${LINEAGE}`);
  });
});
