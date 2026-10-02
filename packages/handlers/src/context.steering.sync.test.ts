/**
 * The repository sync (ADR-184) end to end, over the in-memory registry and a
 * fake GitHub with commits: a push, a merge on GitHub, a rename, a deletion
 * and a broken file each leave the registry matching the production branch,
 * and each problem reaches the sync state and the commit's check.
 *
 * The steering PR cases run the real open and merge handlers against the same
 * registry, so they show the two paths agree: a merge from Oxagen and the sync
 * its push triggers publish one version, not two.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";

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

// The real port, watched, so a test can read the options the production
// sync deps build it with.
vi.mock("./steering-repo/publisher", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("./steering-repo/publisher")>();
  return { ...real, steeringSyncPublish: vi.fn(real.steeringSyncPublish) };
});

import { createOpenSteeringPrHandler } from "./steering.pr.open";
import { createMergeSteeringPrHandler } from "./steering.pr.merge";
import { createProposeRecordHandler } from "./steering.proposal.create";
import { syncView } from "./context.steering.freshness";
import { buildRecordFile, serializeRecordFile } from "./context.steering.file";
import { MERGE_CLAIM_SECONDS } from "./context.steering.store";
import {
  MERGE_GRACE_SECONDS,
  SYNC_CHECK_NAME,
  syncDeps,
  syncWorkspaceSteering,
  type SyncDeps,
} from "./context.steering.sync";
import { steeringSyncPublish } from "./steering-repo/publisher";
import type { SyncFinding } from "./context.steering.sync.plan";
import {
  MemorySyncStore,
  REPO,
  REVIEWER,
  SCOPE,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";
import type { ReconcileLinks } from "./repository.link.reconcile";
import {
  githubRepoRef,
  newWorkspaceToml,
  readWorkspaceToml,
  withRepository,
} from "./repository.workspace-toml";

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
  it.each(["missing", "refused", "unavailable"] as const)(
    "keeps live records and settings unchanged when provenance is %s",
    async (failure) => {
      const r = rig({
        [`${RULES}/ctx.a.one.toml`]: recordText("ctx.a.one"),
        "steering/governance.toml": 'mode = "solo"',
      });
      r.h.github.remove("main", "steering/governance.toml", "Oxagen-Version: 2");
      const repo = { ...REPO, requiresSteeringProvenance: true };
      vi.spyOn(r.h.github, "resolveRepository").mockResolvedValue(repo);
      const apply = vi.spyOn(r.sync, "apply");
      const settings = vi.spyOn(r.sync, "publishWorkspaceSettings");
      const links = vi.fn(async () => ({ linked: [], unlinked: [], findings: [] }));
      r.deps.reconcileLinks = links;
      const publish = vi.fn(async () => null);
      r.deps.publish = publish;
      if (failure !== "missing")
        r.deps.github.assertSteeringCommit = vi.fn(async () => {
          throw new Error(failure);
        });

      await expect(r.run()).rejects.toThrow();

      expect(apply).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
      expect(links).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(active(r)).toEqual([]);
    },
  );

  it("verifies the captured head even when it has no governance file", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    const verify = vi.fn(async () => undefined);
    r.deps.github.assertSteeringCommit = verify;
    const head = await r.h.github.branchHead(REPO, "main");

    const result = await r.run();

    expect(verify).toHaveBeenCalledWith(REPO, head);
    expect(result.outcome).toBe("synced");
    expect(result.created).toBe(1);
  });

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

  it("answers no_repository for a workspace with no steering repository", async () => {
    const r = rig();
    r.h.github.repository = null;
    const out = await r.run();
    expect(out.outcome).toBe("no_repository");
    expect(r.sync.state).toBeNull();
  });

  // A webhook stamps the request before the sync finds there is nothing to
  // read: a retired GitHub connection, or a GitLab project that is not the
  // steering one. Left unanswered, the stamp reads as pending for good and the
  // page refreshes itself forever.
  it("answers a stamped request even when there is no repository to read", async () => {
    const r = rig();
    r.h.github.repository = null;
    await r.sync.markRequested(SCOPE, r.h.now());
    await r.run();
    expect(syncView(r.sync.state)?.status).toBe("failed");
    expect(r.sync.state?.error).toContain("no steering repository");
  });
});

describe("Steering PRs on the host", () => {
  const LINEAGE = "ctx.release.no-reread-changelog";

  async function openedAndPassed(r: Rig): Promise<string> {
    const { proposalId } = await createProposeRecordHandler(r.h)(
      steeringProposalCreate.input.parse({
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
    await createOpenSteeringPrHandler(r.h)({ proposalId }, ctx());
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
      `steering/${LINEAGE}`,
    ))!.replace("more than once in a run.", "more than once per run.");
    r.h.github.commit(`steering/${LINEAGE}`, path, edited);
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
      `steering/${LINEAGE}`,
      path,
      recordText(LINEAGE, "Edited on the PR."),
    );
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    pastGrace(r);
    await expect(
      createMergeSteeringPrHandler(r.h)(
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
    const merge = createMergeSteeringPrHandler(r.h);
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
      `steering/${LINEAGE}`,
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
      // No person closed it; the steering PR page reads this as a close on
      // the host (#5077).
      updatedById: null,
    });
    expect(active(r)).toEqual([]);
    // The next proposal on the lineage branches from main, not from the
    // closed PR's commits.
    expect(r.h.github.deletedBranches).toContain(`steering/${LINEAGE}`);
  });

  it("resets the checks when the PR's branch moves on GitHub", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    const path = proposal(r, id).path!;
    const moved = r.h.github.commit(
      `steering/${LINEAGE}`,
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
  it("leaves a fresh Oxagen merge to merge_steering_pr and publishes it once", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    r.deps.now = () =>
      new Date(r.h.github.pulls[0]!.mergedAt!.getTime() + 5000);

    const early = await r.run();
    expect(early.retryAfterSeconds).toBe(MERGE_GRACE_SECONDS);
    expect(active(r)).toEqual([]);
    expect(proposal(r, id).status).toBe("checks_passed");

    await createMergeSteeringPrHandler(r.h)(
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
    expect(r.h.github.deletedBranches).toContain(`steering/${LINEAGE}`);
  });

  // ── The merge claim (#4504) ────────────────────────────────────────────────

  /** A claim older than MERGE_CLAIM_SECONDS at the sync's clock. */
  const lapsed = (r: Rig) =>
    new Date(r.deps.now().getTime() - (MERGE_CLAIM_SECONDS + 1) * 1000);

  /**
   * Claims the proposal between the sync's read of the PR and its write, as
   * a merge from Oxagen can. The sync holds the row it read, so the stored
   * row is replaced rather than changed in place.
   */
  const claimAfterRead = (r: Rig, id: string) => {
    const realGet = r.h.github.getPullRequest.bind(r.h.github);
    return vi
      .spyOn(r.h.github, "getPullRequest")
      .mockImplementation(async (repo, number) => {
        const i = r.h.store.proposals.findIndex((p) => p.publicId === id);
        r.h.store.proposals[i] = {
          ...r.h.store.proposals[i]!,
          mergeClaimedAt: r.deps.now(),
        };
        return realGet(repo, number);
      });
  };

  // A merge from Oxagen stamps the PR, so the host merges a head the row
  // does not name. While the claim stands, the sync leaves the merge to it.
  it("defers a PR merged at another head while a merge claims it, and publishes it once the claim lapses", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    r.h.github.commit(
      `steering/${LINEAGE}`,
      proposal(r, id).path!,
      recordText(LINEAGE, "Stamped."),
    );
    r.h.github.mergeOnHost(r.h.github.pulls[0]!.number);
    pastGrace(r);
    Object.assign(proposal(r, id), { mergeClaimedAt: r.deps.now() });

    const claimed = await r.run();
    expect(claimed.retryAfterSeconds).toBe(MERGE_GRACE_SECONDS);
    expect(claimed.proposals).toMatchObject({ merged: 0, rejected: 0 });
    expect(proposal(r, id).status).toBe("checks_passed");
    expect(active(r)).toEqual([]);

    // A claim taken after the sync read the PR still holds the link and the
    // rejection off.
    Object.assign(proposal(r, id), { mergeClaimedAt: null });
    const spy = claimAfterRead(r, id);
    const raced = await r.run();
    spy.mockRestore();
    expect(raced.proposals).toMatchObject({ merged: 0, rejected: 0 });
    expect(proposal(r, id).status).toBe("checks_passed");

    Object.assign(proposal(r, id), { mergeClaimedAt: lapsed(r) });
    const out = await r.run();
    expect(out.proposals.merged).toBe(1);
    expect(proposal(r, id)).toMatchObject({
      status: "merged",
      mergeClaimedAt: null,
    });
    expect(active(r)[0]?.statement).toBe("Stamped.");
  });

  it("does not reset the checks of a claimed PR whose head moved", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    const checked = proposal(r, id).headSha;
    r.h.github.commit(
      `steering/${LINEAGE}`,
      proposal(r, id).path!,
      recordText(LINEAGE, "Stamped."),
    );
    Object.assign(proposal(r, id), { mergeClaimedAt: r.deps.now() });

    const out = await r.run();
    expect(out.proposals.stale).toBe(0);
    expect(proposal(r, id)).toMatchObject({
      status: "checks_passed",
      headSha: checked,
    });
  });

  it("does not reject a claimed PR closed on the host until the claim lapses", async () => {
    const r = rig();
    const id = await openedAndPassed(r);
    r.h.github.closeOnHost(r.h.github.pulls[0]!.number);
    Object.assign(proposal(r, id), { mergeClaimedAt: r.deps.now() });

    const claimed = await r.run();
    expect(claimed.proposals.rejected).toBe(0);
    expect(proposal(r, id).status).toBe("checks_passed");
    expect(r.h.github.deletedBranches).not.toContain(`steering/${LINEAGE}`);

    // A claim taken after the sync read the PR refuses the rejection too.
    Object.assign(proposal(r, id), { mergeClaimedAt: null });
    const spy = claimAfterRead(r, id);
    const raced = await r.run();
    spy.mockRestore();
    expect(raced.proposals.rejected).toBe(0);
    expect(proposal(r, id).status).toBe("checks_passed");

    Object.assign(proposal(r, id), { mergeClaimedAt: lapsed(r) });
    const out = await r.run();
    expect(out.proposals.rejected).toBe(1);
    expect(proposal(r, id)).toMatchObject({
      status: "rejected",
      dismissedReason: "Closed on GitHub without merging",
    });
    expect(r.h.github.deletedBranches).toContain(`steering/${LINEAGE}`);
  });
});

/** A workspace/v1 file, with `[stella]` when `stella` is given. */
function workspaceToml(stella?: string): string {
  return [
    schemaDirective("workspace/v1"),
    'schema = "workspace/v1"',
    'organization = "a-intel"',
    'workspace = "core-platform"',
    ...(stella === undefined ? [] : ["", "[stella]", stella]),
    "",
  ].join("\n");
}

describe("workspace.toml settings (#4435)", () => {
  it("publishes the Stella archive window workspace.toml sets", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      "workspace.toml",
      workspaceToml("archive_after_days = 30"),
    );
    const out = await r.run();
    expect(r.sync.published).toEqual([{ stellaArchiveAfterDays: 30, embeddings: null }]);
    expect(out.findings).toEqual([]);
  });

  it("publishes the embeddings provider workspace.toml sets, and clears it when unset (ADR-217)", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      "workspace.toml",
      [
        workspaceToml(),
        "[embeddings]",
        'provider = "custom"',
        'url = "https://embed.example.com/v1/embeddings"',
        'model = "embed-small"',
        'credential = "oxagen:credential/embed-key"',
        "",
      ].join("\n"),
    );
    const out = await r.run();
    expect(out.findings).toEqual([]);
    expect(r.sync.published).toEqual([
      {
        stellaArchiveAfterDays: null,
        embeddings: {
          provider: "custom",
          url: "https://embed.example.com/v1/embeddings",
          model: "embed-small",
          credential: "oxagen:credential/embed-key",
        },
      },
    ]);

    r.h.github.commit("main", "workspace.toml", workspaceToml());
    await r.run();
    expect(r.sync.published.at(-1)).toEqual({ stellaArchiveAfterDays: null, embeddings: null });
  });

  it("clears the window when workspace.toml sets none or is removed", async () => {
    const r = rig();
    await r.run();
    expect(r.sync.published).toEqual([{ stellaArchiveAfterDays: null, embeddings: null }]);
    r.h.github.commit(
      "main",
      "workspace.toml",
      workspaceToml("archive_after_days = 14"),
    );
    await r.run();
    r.h.github.commit("main", "workspace.toml", workspaceToml());
    await r.run();
    r.h.github.commit(
      "main",
      "workspace.toml",
      workspaceToml("archive_after_days = 21"),
    );
    await r.run();
    r.h.github.remove("main", "workspace.toml");
    await r.run();
    expect(r.sync.published.map((p) => p.stellaArchiveAfterDays)).toEqual([
      null,
      14,
      null,
      21,
      null,
    ]);
  });

  it("reads nothing when the head has not moved", async () => {
    const r = rig();
    await r.run();
    await r.run();
    expect(r.sync.published).toHaveLength(1);
  });

  it("leaves a workspace.toml that is not workspace/v1 to its own tool", async () => {
    const r = rig();
    r.h.github.commit("main", "workspace.toml", '[tool]\nname = "other"\n');
    const out = await r.run();
    expect(r.sync.published).toEqual([{ stellaArchiveAfterDays: null, embeddings: null }]);
    expect(out.findings).toEqual([]);
  });

  // The file can sit at the root of a code repository. A mistake in it must
  // not fail that repository's check, and the sweep keeps the last window.
  it("keeps the last window and warns when workspace.toml does not read", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      "workspace.toml",
      workspaceToml("archive_after_days = 30"),
    );
    await r.run();
    r.h.github.commit(
      "main",
      "workspace.toml",
      workspaceToml("archive_after_days = 0"),
    );
    const out = await r.run();
    expect(r.sync.published).toEqual([{ stellaArchiveAfterDays: 30, embeddings: null }]);
    expect(out.outcome).toBe("problems");
    expect(r.sync.state?.findings).toEqual([
      expect.objectContaining({
        level: "warning",
        path: "workspace.toml",
        code: "schema",
      }),
    ]);
    expect(r.sync.state?.findings[0]?.message).toContain(
      "workspace.toml at line 6, stella.archive_after_days:",
    );
    expect(r.h.github.checkRuns.at(-1)).toMatchObject({
      name: SYNC_CHECK_NAME,
      conclusion: "success",
    });

    // A push elsewhere reads the file again and finds the same warning, so
    // it posts no new check.
    r.h.github.commit("main", "src/index.ts", "export {};\n");
    await r.run();
    expect(r.sync.state?.findings).toHaveLength(1);
    expect(r.sync.published).toHaveLength(1);
    expect(r.h.github.checkRuns).toHaveLength(2);

    r.h.github.commit(
      "main",
      "workspace.toml",
      workspaceToml("archive_after_days = 45"),
    );
    await r.run();
    expect(r.sync.published.at(-1)).toEqual({ stellaArchiveAfterDays: 45, embeddings: null });
    expect(r.sync.state?.findings).toEqual([]);
  });

  it("reports a workspace.toml that is not TOML without quoting it", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      "workspace.toml",
      `${schemaDirective("workspace/v1")}\n[stella\n`,
    );
    await r.run();
    expect(r.sync.published).toEqual([]);
    expect(r.sync.state?.findings).toEqual([
      expect.objectContaining({ level: "warning", code: "not_toml" }),
    ]);
    expect(r.sync.state?.findings[0]?.message).toMatch(
      /^workspace\.toml is not valid TOML/,
    );
  });
});

describe("publishing the steering repository (#4447)", () => {
  // The sync reads the main code repository, so it hands the publisher only
  // the workspace's scope. The publisher resolves the steering repository and
  // reads its head, and never receives the code repository's name or head.
  it("publishes with the workspace's scope and no code repository", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    const publish = vi.fn(async () => ({
      status: "published" as const,
      version: 1,
    }));
    const out = await syncWorkspaceSteering({ ...r.deps, publish }, SCOPE);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]).toEqual([SCOPE]);
    expect(out.published).toEqual({ status: "published", version: 1 });
    expect(out.outcome).toBe("synced");
  });

  it("asks for a publish when the code repository has not moved", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    const publish = vi.fn(async () => ({
      status: "current" as const,
      version: 1,
    }));
    const deps = { ...r.deps, publish };
    await syncWorkspaceSteering(deps, SCOPE);
    const again = await syncWorkspaceSteering(deps, SCOPE);
    expect(again.outcome).toBe("current");
    expect(publish).toHaveBeenCalledTimes(2);
    expect(again.published).toEqual({ status: "current", version: 1 });
  });

  it("publishes nothing and says so when no publisher is wired", async () => {
    const r = rig();
    const out = await r.run();
    expect(out.published).toBeNull();
  });

  // A merge whose own publish failed records no deployment. The sync that
  // publishes it later records the one deployment instead (#4449).
  // publisher.test.ts shows the port records one per published version and
  // none for a current, refused, or stale head.
  it("asks the production port to record each version it publishes as a deployment", () => {
    syncDeps();
    expect(vi.mocked(steeringSyncPublish)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(steeringSyncPublish)).toHaveBeenCalledWith(
      expect.objectContaining({ recordDeployments: true }),
    );
  });

  it("keeps the sync when the publish throws, and the next sync tries again", async () => {
    const r = rig();
    r.h.github.commit(
      "main",
      `${RULES}/ctx.a.one.toml`,
      recordText("ctx.a.one"),
    );
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("the version store is down"))
      .mockResolvedValueOnce({ status: "published", version: 1 });
    const deps = { ...r.deps, publish };
    const first = await syncWorkspaceSteering(deps, SCOPE);
    expect(first.outcome).toBe("synced");
    expect(first.published).toBeNull();
    expect(r.sync.state).toMatchObject({ status: "synced", error: null });
    const second = await syncWorkspaceSteering(deps, SCOPE);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(second.published).toEqual({ status: "published", version: 1 });
  });
});

describe("workspace.toml repositories (ADR-212)", () => {
  const API = githubRepoRef("a-intel", "api");
  const WEB = githubRepoRef("a-intel", "web");
  const DOCS = githubRepoRef("a-intel", "docs");

  const LINK_WARNING: SyncFinding = {
    level: "warning",
    path: "workspace.toml",
    lineageId: null,
    code: "repository_link",
    message:
      "workspace.toml lists github.com/a-intel/web, and Oxagen could not link it (repository_not_found).",
  };

  /** A workspace/v1 file whose `[[repositories]]` list holds these refs, in order. */
  function listing(first: string, ...rest: string[]): string {
    let text = newWorkspaceToml("a-intel", "core-platform", first);
    for (const ref of rest) {
      const file = readWorkspaceToml(text);
      if (file.kind !== "read")
        throw new Error("The fixture does not read as workspace/v1.");
      text = withRepository(file, ref);
    }
    return text;
  }

  /** The rig with a reconcile spy that links nothing and finds nothing. */
  function linkRig() {
    const r = rig();
    const reconcileLinks = vi.fn<ReconcileLinks>(async () => ({
      linked: [],
      unlinked: [],
      findings: [],
    }));
    const deps: SyncDeps = { ...r.deps, reconcileLinks };
    return {
      ...r,
      deps,
      reconcileLinks,
      run: (force = false) => syncWorkspaceSteering(deps, SCOPE, { force }),
    };
  }

  it("reconciles the first synced head with no prior list", async () => {
    const r = linkRig();
    r.h.github.commit("main", "workspace.toml", listing(API, WEB));
    await r.run();
    expect(r.reconcileLinks).toHaveBeenCalledTimes(1);
    expect(r.reconcileLinks).toHaveBeenCalledWith(SCOPE, {
      prior: null,
      current: [API, WEB],
      now: expect.any(Date),
    });
  });

  it("compares the list at the last synced head with the list at the new head", async () => {
    const r = linkRig();
    const first = r.h.github.commit(
      "main",
      "workspace.toml",
      listing(API, WEB),
    );
    await r.run();
    const second = r.h.github.commit(
      "main",
      "workspace.toml",
      listing(API, DOCS),
    );
    const readFile = vi.spyOn(r.h.github, "readFile");
    await r.run();
    expect(readFile).toHaveBeenCalledWith(
      expect.anything(),
      "workspace.toml",
      first,
    );
    expect(readFile).toHaveBeenCalledWith(
      expect.anything(),
      "workspace.toml",
      second,
    );
    expect(r.reconcileLinks).toHaveBeenCalledTimes(2);
    expect(r.reconcileLinks).toHaveBeenLastCalledWith(SCOPE, {
      prior: [API, WEB],
      current: [API, DOCS],
      now: expect.any(Date),
    });
    expect(r.sync.state?.headSha).toBe(second);
  });

  it("does not reconcile again when the head has not moved", async () => {
    const r = linkRig();
    r.h.github.commit("main", "workspace.toml", listing(API));
    await r.run();
    expect(r.sync.state?.status).toBe("synced");
    await r.run();
    expect(r.reconcileLinks).toHaveBeenCalledTimes(1);
  });

  it("reconciles a forced run at the same head against the list that head holds", async () => {
    const r = linkRig();
    r.h.github.commit("main", "workspace.toml", listing(API, WEB));
    await r.run();
    const readFile = vi.spyOn(r.h.github, "readFile");
    await r.run(true);
    expect(r.reconcileLinks).toHaveBeenCalledTimes(2);
    expect(r.reconcileLinks).toHaveBeenLastCalledWith(SCOPE, {
      prior: [API, WEB],
      current: [API, WEB],
      now: expect.any(Date),
    });
    // The prior list is the one the head holds, so the sync reads the file once.
    expect(
      readFile.mock.calls.filter(([, path]) => path === "workspace.toml"),
    ).toHaveLength(1);
  });

  // The new steering repository's history says nothing about the list the old
  // one held, so no head is removed on its word.
  it("reconciles with no prior list after the steering repository is replaced", async () => {
    const r = linkRig();
    const first = r.h.github.commit(
      "main",
      "workspace.toml",
      listing(API, WEB),
    );
    await r.run();
    r.h.github.repository = {
      ...REPO,
      repo: "steering",
      fullName: "a-intel/steering",
      currentFullName: "a-intel/steering",
    };
    r.h.github.commit("main", "workspace.toml", listing(API));
    const readFile = vi.spyOn(r.h.github, "readFile");
    await r.run();
    expect(r.reconcileLinks).toHaveBeenLastCalledWith(SCOPE, {
      prior: null,
      current: [API],
      now: expect.any(Date),
    });
    expect(readFile).not.toHaveBeenCalledWith(
      expect.anything(),
      "workspace.toml",
      first,
    );
    expect(r.sync.state?.repository).toBe("a-intel/steering");
  });

  // The fork case: the new repository holds the old one's commits. A failed
  // first sync there must not store the old head beside the new name.
  it("keeps no head from the old steering repository when the new one's first sync fails", async () => {
    const r = linkRig();
    const first = r.h.github.commit(
      "main",
      "workspace.toml",
      listing(API, WEB),
    );
    await r.run();
    r.h.github.repository = {
      ...REPO,
      repo: "steering",
      fullName: "a-intel/steering",
      currentFullName: "a-intel/steering",
    };
    r.h.github.commit("main", "workspace.toml", listing(API));
    r.reconcileLinks.mockRejectedValueOnce(new Error("The database is down."));
    await expect(r.run()).rejects.toThrow("The database is down.");
    expect(r.sync.state).toMatchObject({
      repository: "a-intel/steering",
      headSha: null,
      status: "failed",
    });
    const readFile = vi.spyOn(r.h.github, "readFile");
    await r.run();
    expect(r.reconcileLinks).toHaveBeenLastCalledWith(SCOPE, {
      prior: null,
      current: [API],
      now: expect.any(Date),
    });
    expect(readFile).not.toHaveBeenCalledWith(
      expect.anything(),
      "workspace.toml",
      first,
    );
  });

  it("leaves the linked heads alone when workspace.toml does not read", async () => {
    const r = linkRig();
    r.h.github.commit("main", "workspace.toml", listing(API));
    await r.run();
    r.h.github.commit(
      "main",
      "workspace.toml",
      workspaceToml("archive_after_days = 0"),
    );
    const out = await r.run();
    expect(out.findings).toEqual([
      expect.objectContaining({ path: "workspace.toml", code: "schema" }),
    ]);
    // A forced run reads the same file and still moves no head.
    await r.run(true);
    r.h.github.commit(
      "main",
      "workspace.toml",
      `${schemaDirective("workspace/v1")}\n[stella\n`,
    );
    await r.run();
    expect(r.reconcileLinks).toHaveBeenCalledTimes(1);
  });

  // Only a workspace/v1 file that reads moves a head. Removal takes a file
  // that still reads and no longer lists the repository, so a deleted file or
  // a slip on the first line unlinks nothing.
  it("leaves the linked heads alone when workspace.toml is removed or belongs to another tool", async () => {
    const r = linkRig();
    r.h.github.commit("main", "workspace.toml", listing(API));
    await r.run();
    r.h.github.remove("main", "workspace.toml");
    await r.run();
    await r.run(true);
    r.h.github.commit("main", "workspace.toml", '[tool]\nname = "other"\n');
    await r.run();
    expect(r.reconcileLinks).toHaveBeenCalledTimes(1);
    // The next file that reads is compared with the list at the last synced
    // head. Another tool's file lists nothing there, so no head is removed.
    r.h.github.commit("main", "workspace.toml", listing(WEB));
    await r.run();
    expect(r.reconcileLinks).toHaveBeenLastCalledWith(SCOPE, {
      prior: [],
      current: [WEB],
      now: expect.any(Date),
    });
  });

  // A file that did not read at the last synced head says nothing about what
  // it listed. The next file that reads is compared with no prior list, so a
  // repository dropped across the bad head is never unlinked. This pins that.
  it("compares with no prior list when the last synced head's workspace.toml did not read", async () => {
    const r = linkRig();
    r.h.github.commit("main", "workspace.toml", listing(API));
    await r.run();
    const broken = r.h.github.commit(
      "main",
      "workspace.toml",
      `${schemaDirective("workspace/v1")}\n[stella\n`,
    );
    await r.run();
    expect(r.sync.state?.headSha).toBe(broken);
    expect(r.reconcileLinks).toHaveBeenCalledTimes(1);
    r.h.github.commit("main", "workspace.toml", listing(WEB));
    const readFile = vi.spyOn(r.h.github, "readFile");
    await r.run();
    // The sync reads the broken head's file for the prior list.
    expect(readFile).toHaveBeenCalledWith(
      expect.anything(),
      "workspace.toml",
      broken,
    );
    expect(r.reconcileLinks).toHaveBeenCalledTimes(2);
    expect(r.reconcileLinks).toHaveBeenLastCalledWith(SCOPE, {
      prior: null,
      current: [WEB],
      now: expect.any(Date),
    });
  });

  it("reports a repository the sync could not link beside the other findings and still finishes", async () => {
    const r = linkRig();
    r.reconcileLinks.mockResolvedValueOnce({
      linked: [],
      unlinked: [],
      findings: [LINK_WARNING],
    });
    r.h.github.commit("main", `${RULES}/ctx.a.one.toml`, "schema = [broken");
    r.h.github.commit("main", "workspace.toml", listing(API, WEB));
    const out = await r.run();
    expect(out.outcome).toBe("problems");
    expect(out.findings).toEqual([
      expect.objectContaining({
        level: "error",
        path: `${RULES}/ctx.a.one.toml`,
        code: "not_toml",
      }),
      LINK_WARNING,
    ]);
    expect(r.sync.state).toMatchObject({
      status: "problems",
      error: null,
      headSha: r.h.github.heads.get("main"),
    });
    expect(r.sync.state?.findings).toEqual(out.findings);
    expect(r.sync.published).toEqual([{ stellaArchiveAfterDays: null, embeddings: null }]);
  });

  it("keeps the link warning at the same head and clears it when the next head links cleanly", async () => {
    const r = linkRig();
    r.reconcileLinks.mockResolvedValueOnce({
      linked: [],
      unlinked: [],
      findings: [LINK_WARNING],
    });
    r.h.github.commit("main", "workspace.toml", listing(API));
    await r.run();
    const again = await r.run();
    expect(r.reconcileLinks).toHaveBeenCalledTimes(1);
    expect(again.findings).toEqual([LINK_WARNING]);
    r.h.github.commit("main", "workspace.toml", listing(API, WEB));
    const next = await r.run();
    expect(r.reconcileLinks).toHaveBeenCalledTimes(2);
    expect(next.findings).toEqual([]);
    expect(r.sync.state?.status).toBe("synced");
  });

  it("syncs as before when no reconcile is wired", async () => {
    const r = rig();
    r.h.github.commit("main", "workspace.toml", listing(API, WEB));
    const out = await r.run();
    expect(out.findings).toEqual([]);
    expect(r.sync.state).toMatchObject({ status: "synced", error: null });
    expect(r.sync.published).toEqual([{ stellaArchiveAfterDays: null, embeddings: null }]);
  });

  // Step 8 publishes the steering repository on every run, but the linked
  // heads follow the synced head, so only step 5 reconciles them.
  it("reconciles once per synced head and never from the publish step", async () => {
    const r = linkRig();
    r.h.github.commit("main", "workspace.toml", listing(API));
    const seen: number[] = [];
    const publish = vi.fn(async () => {
      seen.push(r.reconcileLinks.mock.calls.length);
      return { status: "published" as const, version: 1 };
    });
    const deps = { ...r.deps, publish };
    await syncWorkspaceSteering(deps, SCOPE);
    await syncWorkspaceSteering(deps, SCOPE);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([1, 1]);
    expect(r.reconcileLinks).toHaveBeenCalledTimes(1);
  });
});
