// `set_governance_mode` against the steering doubles: which route a call takes,
// what reaches GitHub, and what is recorded.
//
// The legacy layout keeps `.oxagen/rules/governance.toml`. Its route is read off
// the file, so each of the four states the production branch can be in gets a
// case: solo (commit), team and regulated (pull request), and a governance.toml
// nothing can parse (pull request, because a mode nobody can establish must not
// be treated as the permissive one). The override takes the strict route back to
// the direct one and is recorded twice, once as a change and once as a skipped
// review, so that "every governance change" and "every skipped review" are each
// one event-type filter.
//
// A steering repository keeps `steering/governance.toml`. Every route there
// opens a steering PR. Solo and Apply now land it through the merge queue. The
// review route leaves it open, records it as a governance proposal, and
// merge_context_pr lands it for an approver (ADR-232, #4795).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextGovernanceModeSet } from "@oxagen/oxagen/contracts/context.governance_mode.set";

const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  // The module-level `steeringDeps()` at the foot of the handler reads these
  // two even though this capability's own gate does not, so the mock has to
  // carry them for the import to evaluate at all.
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async (actor: { userId: string | null }) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    if (gate.refuse)
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Admin";
  },
}));

// The workspace lookup is one read; the row the tests hand back is what
// `resolveTargetWorkspace` is allowed to see.
const row = vi.hoisted(() => ({
  value: {
    id: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
    name: "Platform",
    archivedAt: null as Date | null,
  } as { id: string; name: string; archivedAt: Date | null } | undefined,
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { workspaces: { findFirst: async () => row.value } } }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/tenancy", () => ({
  getPrincipalAttribution: () => ({}),
  runInTenantScope: async (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { REQUIRED_CHECK_NAME } from "@oxagen/oxagen/steering-repo/names";
import {
  promotionSchema,
  type PromotionLine,
} from "@oxagen/oxagen/steering-repo/promotion";
import type { CheckReport } from "@oxagen/steering-check";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { makeSetGovernanceModeHandler } from "./context.governance_mode.set";
import { createGetContextPrHandler } from "./context.pr.get";
import {
  createMergeContextPrHandler,
  type MergeSeams,
} from "./context.pr.merge";
import { contextPrMergeWithoutReview } from "@oxagen/oxagen/contracts/context.pr.merge_without_review";
import {
  MERGE_GRACE_SECONDS,
  syncWorkspaceSteering,
  type SyncDeps,
} from "./context.steering.sync";
import {
  AUTHOR,
  ctx,
  harness,
  MemorySyncStore,
  REPO,
  REVIEWER,
  SCOPE,
  type Harness,
} from "./context.steering.test-support";
import {
  STEERING_GOVERNANCE_PR_BODY,
  type SteeringGovernanceSeams,
} from "./steering-repo/governance-mode";
import type { SteeringPublisher } from "./steering-repo/publisher";

const GOVERNANCE = ".oxagen/rules/governance.toml";

/** A harness whose production branch declares `mode`, or the raw text given. */
function withMode(text: string | null): Harness {
  return harness(
    text === null ? {} : { [`${REPO.defaultBranch}:${GOVERNANCE}`]: text },
  );
}

function run(
  deps: Harness,
  input: { mode: string; applyImmediately?: boolean },
  seams?: SteeringGovernanceSeams,
) {
  const handler = makeSetGovernanceModeHandler(deps, seams);
  return handler(
    contextGovernanceModeSet.input.parse(input),
    ctx({ userId: AUTHOR }),
  );
}

beforeEach(() => {
  gate.refuse = false;
  row.value = {
    id: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
    name: "Platform",
    archivedAt: null,
  };
});

describe("set_governance_mode", () => {
  it("commits to the production branch when solo is in force", async () => {
    const deps = withMode('mode = "solo"\n');
    const out = await run(deps, { mode: "regulated" });

    expect(out).toMatchObject({
      outcome: "applied",
      previousMode: "solo",
      effectiveMode: "regulated",
      fullName: REPO.fullName,
      productionBranch: REPO.defaultBranch,
      // The legacy layout keeps its file and its direct commit.
      path: GOVERNANCE,
      pullRequest: null,
      // Nothing was overridden: solo's route commits anyway, so there was no
      // review to skip.
      overrodeReview: false,
    });
    expect(deps.github.commits).toEqual([
      expect.objectContaining({
        path: GOVERNANCE,
        branch: REPO.defaultBranch,
      }),
    ]);
    // The file it wrote is the one the parser reads, not prose about it.
    const written = await deps.github.readFile(
      REPO,
      GOVERNANCE,
      REPO.defaultBranch,
    );
    expect(written).toContain('mode = "regulated"');
    expect(written).toContain("separation_of_duties = true");
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
    ]);
  });

  it.each(["team", "regulated"])(
    "opens a pull request when %s is in force",
    async (current) => {
      const deps = withMode(`mode = "${current}"\n`);
      const out = await run(deps, { mode: "solo" });

      expect(out).toMatchObject({
        outcome: "proposed",
        previousMode: current,
        // Nothing moved: the production branch still says what it said.
        effectiveMode: current,
        commitSha: null,
        overrodeReview: false,
      });
      expect(out.pullRequest).toMatchObject({ reused: false });
      expect(deps.github.pulls[0]).toMatchObject({
        head: "oxagen/governance",
        labels: ["no-issue"],
      });
      // The branch, never the production branch.
      expect(deps.github.commits).toEqual([
        expect.objectContaining({ branch: "oxagen/governance" }),
      ]);
      expect(
        await deps.github.readFile(REPO, GOVERNANCE, REPO.defaultBranch),
      ).toContain(`mode = "${current}"`);
      // A proposal changes no mode, so it records no governance change: the
      // pull request is the record until someone merges it.
      expect(deps.events).toEqual([]);
    },
  );

  it("takes the strict route when governance.toml cannot be parsed", async () => {
    const deps = withMode('mode = "permissive"\n');
    const out = await run(deps, { mode: "team" });

    expect(out).toMatchObject({
      outcome: "proposed",
      // Neither claims a mode: the repository said something Oxagen cannot
      // read, and reporting `team` here would put words in its mouth.
      previousMode: null,
      effectiveMode: null,
    });
  });

  it("treats an absent governance.toml as unestablished, not as team", async () => {
    const deps = withMode(null);
    const out = await run(deps, { mode: "solo" });

    // The default a missing file falls to is `team`, so the route is the strict
    // one — but `previousMode` stays null, because the file never said team.
    expect(out).toMatchObject({ outcome: "proposed", previousMode: null });
  });

  it("commits despite the review when the caller overrides, and records both", async () => {
    const deps = withMode('mode = "regulated"\n');
    const out = await run(deps, { mode: "solo", applyImmediately: true });

    expect(out).toMatchObject({
      outcome: "applied",
      previousMode: "regulated",
      effectiveMode: "solo",
      overrodeReview: true,
      pullRequest: null,
    });
    expect(deps.github.commits).toEqual([
      expect.objectContaining({ branch: REPO.defaultBranch }),
    ]);
    // Both events, so neither "every governance change" nor "every skipped
    // review" is a filter that quietly misses rows.
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
      "steering.governance_overridden",
    ]);
    expect(deps.events[0]?.detail).toMatchObject({
      previousMode: "regulated",
      mode: "solo",
      overrodeReview: true,
      fullName: REPO.fullName,
    });
    expect(deps.events[0]?.actorUserId).toBe(AUTHOR);
  });

  it("changes nothing when the override is spent under solo", async () => {
    const deps = withMode('mode = "solo"\n');
    const out = await run(deps, { mode: "team", applyImmediately: true });

    // Solo commits either way, so there is no skipped review to record.
    expect(out).toMatchObject({ outcome: "applied", overrodeReview: false });
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
    ]);
  });

  it("writes nothing when the file already declares the mode", async () => {
    const deps = withMode('mode = "team"\n');
    const out = await run(deps, { mode: "team" });

    expect(out).toMatchObject({
      outcome: "unchanged",
      previousMode: "team",
      effectiveMode: "team",
      commitSha: null,
      pullRequest: null,
    });
    // No empty commit and no diffless pull request.
    expect(deps.github.commits).toEqual([]);
    expect(deps.github.branches).toEqual([]);
    expect(deps.events).toEqual([]);
  });

  it("reuses a pull request already open on the branch and says so", async () => {
    const deps = withMode('mode = "team"\n');
    const first = await run(deps, { mode: "solo" });
    const second = await run(deps, { mode: "regulated" });

    expect(first.pullRequest).toMatchObject({ reused: false });
    expect(second.pullRequest).toMatchObject({
      number: first.pullRequest?.number,
      reused: true,
    });
    // The branch is pushed before the pull request is looked for, so the
    // reused one carries the LATEST ask, not the first.
    expect(
      await deps.github.readFile(REPO, GOVERNANCE, "oxagen/governance"),
    ).toContain('mode = "regulated"');
  });

  it("refuses an archived workspace (negative)", async () => {
    row.value = {
      id: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
      name: "Platform",
      archivedAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const deps = withMode('mode = "solo"\n');
    await expect(run(deps, { mode: "team" })).rejects.toMatchObject({
      code: "conflict",
      reason: "workspace_archived",
    });
    expect(deps.github.commits).toEqual([]);
  });

  it("refuses a workspace that is not the organization's (negative)", async () => {
    row.value = undefined;
    const deps = withMode('mode = "solo"\n');
    await expect(run(deps, { mode: "team" })).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_not_found",
    });
  });

  it("refuses a caller without the role, before anything is written (negative)", async () => {
    gate.refuse = true;
    const deps = withMode('mode = "solo"\n');
    await expect(
      run(deps, { mode: "team", applyImmediately: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(deps.github.commits).toEqual([]);
    expect(deps.events).toEqual([]);
  });

  it("reports GitHub's own refusal rather than a generic one (negative)", async () => {
    const deps = withMode('mode = "solo"\n');
    deps.github.putFile = () => {
      throw new Error("GitHub API error 409: branch is protected");
    };
    await expect(run(deps, { mode: "team" })).rejects.toMatchObject({
      code: "conflict",
      reason: "github_refused",
      message: "GitHub API error 409: branch is protected",
    });
  });
});

// ── The steering layout ─────────────────────────────────────────────────────

const STEERING_FILE = "steering/governance.toml";
const STEERING_BRANCH = "steering/governance";
const LEDGER = "steering/promotions/2026-09.jsonl";

/** The fixture steering repository on the production branch, with its file edited. */
function steeringRepo(edit: (text: string) => string = (text) => text): Harness {
  const seed: Record<string, string> = {};
  for (const [path, text] of fixtureRepo())
    seed[`${REPO.defaultBranch}:${path}`] = text;
  const key = `${REPO.defaultBranch}:${STEERING_FILE}`;
  seed[key] = edit(seed[key] ?? "");
  return harness(seed);
}

/** The fixture steering repository with `mode` in force. It says team. */
function steeringMode(mode: "solo" | "team"): Harness {
  return steeringRepo((text) =>
    text.replace('mode = "team"', `mode = "${mode}"`),
  );
}

/** A report in which every check the merge trailer names passed. */
function passed(): CheckReport {
  return {
    passed: true,
    results: (["schema", "lineage", "hash"] as const).map((check) => ({
      check,
      status: "passed" as const,
      summary: `${check} passed`,
      findings: [],
    })),
    findings: [],
  };
}

/** A report with one error on the mode line. */
function failed(): CheckReport {
  const finding = {
    check: "schema" as const,
    rule: "governance-mode",
    severity: "error" as const,
    path: STEERING_FILE,
    line: 3,
    field: "mode",
    message: "mode is not one Oxagen reads",
    expected: "solo, team, or regulated",
    fix: "Set mode to solo, team, or regulated.",
  };
  return {
    passed: false,
    results: [
      {
        check: "schema",
        status: "failed",
        summary: "1 error",
        findings: [finding],
      },
    ],
    findings: [finding],
  };
}

interface Doubles extends SteeringGovernanceSeams {
  /** Each head the checks ran on, with the production head they compared it to. */
  checked: { head: string; base: string }[];
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
    store: { highestVersion: async () => 20, versionAt: async () => null },
    publish: async (_repo, commit) => held(commit),
    withLock: (_repo, fn) => fn(held),
  };
}

/** Seams for a healthy repository whose publisher is at version 20. */
function doubles(report: CheckReport = passed()): Doubles {
  const checked: { head: string; base: string }[] = [];
  const published: string[] = [];
  return {
    checked,
    published,
    check: async (_scope, _host, _repo, head, base) => {
      checked.push({ head, base });
      return report;
    },
    readHealth: async () => "healthy",
    publisher: async () => fakePublisher(published),
  };
}

async function lastLedgerLine(deps: Harness): Promise<PromotionLine> {
  const text =
    (await deps.github.readFile(REPO, LEDGER, REPO.defaultBranch)) ?? "";
  const lines = text.split("\n").filter((line) => line !== "");
  return promotionSchema.parse(JSON.parse(lines[lines.length - 1] ?? "{}"));
}

async function productionText(deps: Harness): Promise<string> {
  return (
    (await deps.github.readFile(REPO, STEERING_FILE, REPO.defaultBranch)) ?? ""
  );
}

describe("set_governance_mode in a steering repository", () => {
  it("lands the change through the merge queue when solo is in force", async () => {
    const deps = steeringMode("solo");
    const before = await productionText(deps);
    const seams = doubles();

    const out = await run(deps, { mode: "team" }, seams);

    expect(out).toMatchObject({
      outcome: "applied",
      previousMode: "solo",
      effectiveMode: "team",
      path: STEERING_FILE,
      overrodeReview: false,
    });
    expect(out.pullRequest).toMatchObject({ reused: false });
    // No direct commit reaches the production branch. The only write is to
    // the steering branch, and the merge queue merges its PR.
    expect(deps.github.commits).toEqual([
      expect.objectContaining({ path: STEERING_FILE, branch: STEERING_BRANCH }),
    ]);
    expect(deps.github.merges).toHaveLength(1);
    expect(deps.github.merges[0]?.commitTitle).toBe(
      `steering: set governance mode to team (#${out.pullRequest?.number})`,
    );
    expect(out.commitSha).toBe(deps.github.pulls[0]?.mergeCommitSha);
    // Only the mode changed. Every other setting and comment is as it was.
    expect(await productionText(deps)).toBe(
      before.replace('mode = "solo"', 'mode = "team"'),
    );
    // The ledger names the caller as the approver, as solo allows.
    expect(await lastLedgerLine(deps)).toMatchObject({
      seq: 21,
      approved_by: [AUTHOR],
      merged_by: AUTHOR,
      without_review: false,
      changes: [expect.objectContaining({ path: STEERING_FILE })],
    });
    expect(seams.published).toEqual([out.commitSha]);
    expect(deps.github.deletedBranches).toContain(STEERING_BRANCH);
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
    ]);
  });

  it("lands Apply now in team as an override, and records it as one", async () => {
    const deps = steeringMode("team");
    const seams = doubles();

    const out = await run(
      deps,
      { mode: "solo", applyImmediately: true },
      seams,
    );

    expect(out).toMatchObject({
      outcome: "applied",
      previousMode: "team",
      effectiveMode: "solo",
      path: STEERING_FILE,
      overrodeReview: true,
    });
    expect(deps.github.merges).toHaveLength(1);
    // Nobody approved it, and the ledger says so.
    expect(await lastLedgerLine(deps)).toMatchObject({
      approved_by: [],
      merged_by: AUTHOR,
      without_review: true,
    });
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
      "steering.governance_overridden",
    ]);
    expect(deps.events[1]).toMatchObject({
      actorUserId: AUTHOR,
      detail: expect.objectContaining({
        previousMode: "team",
        mode: "solo",
        overrodeReview: true,
      }),
    });
  });

  it("opens the steering PR and changes nothing when team asks for review", async () => {
    const deps = steeringMode("team");
    const before = await productionText(deps);
    const seams = doubles();

    const out = await run(deps, { mode: "solo" }, seams);

    expect(out).toMatchObject({
      outcome: "proposed",
      previousMode: "team",
      // The PR waits for review, so the mode in force is still team.
      effectiveMode: "team",
      commitSha: null,
      path: STEERING_FILE,
      overrodeReview: false,
    });
    expect(out.pullRequest).toMatchObject({ reused: false });
    expect(deps.github.pulls).toEqual([
      expect.objectContaining({
        head: STEERING_BRANCH,
        base: REPO.defaultBranch,
        labels: ["no-issue"],
        state: "open",
      }),
    ]);
    // The PR tells nobody to land it with Apply now: that is an override.
    expect(deps.github.pulls[0]?.body).toBe(STEERING_GOVERNANCE_PR_BODY);
    expect(STEERING_GOVERNANCE_PR_BODY).not.toMatch(/Apply now/);
    expect(deps.github.pulls[0]?.body).toContain("Who merges through Oxagen");
    expect(deps.github.pulls[0]?.body).toContain(
      "GitHub repository permissions govern direct pushes and merges in GitHub.",
    );
    expect(deps.github.pulls[0]?.body).not.toContain("only Oxagen merges");
    // The required check is on the PR's head, compared with the production head.
    const head = await deps.github.branchHead(REPO, STEERING_BRANCH);
    expect(deps.github.checkRuns).toEqual([
      expect.objectContaining({
        name: REQUIRED_CHECK_NAME,
        headSha: head,
        conclusion: "success",
      }),
    ]);
    expect(seams.checked).toEqual([{ head, base: "base0" }]);
    expect(deps.github.merges).toEqual([]);
    expect(seams.published).toEqual([]);
    expect(await productionText(deps)).toBe(before);
    expect(
      await deps.github.readFile(REPO, STEERING_FILE, STEERING_BRANCH),
    ).toBe(before.replace('mode = "team"', 'mode = "solo"'));
    // A proposal records no governance change and no override.
    expect(deps.events).toEqual([]);
    // The PR is recorded as a governance proposal, for merge_context_pr to
    // land for an approver (#4795), and the answer names it for the page.
    expect(out.proposalId).toBe(deps.store.proposals[0]?.publicId);
    expect(deps.store.proposals).toEqual([
      expect.objectContaining({
        lineageId: "governance",
        kind: "governance",
        force: "info",
        status: "checks_passed",
        governanceMode: "team",
        branch: STEERING_BRANCH,
        path: STEERING_FILE,
        prNumber: out.pullRequest?.number,
        headSha: head,
        checks: [],
        createdById: AUTHOR,
        statement: "Change the steering governance mode from team to solo.",
      }),
    ]);
  });

  it("records a governance proposal whose checks failed, for the page to show", async () => {
    const deps = steeringMode("team");
    await run(deps, { mode: "solo" }, doubles(failed()));
    expect(deps.store.proposals).toEqual([
      expect.objectContaining({ kind: "governance", status: "checks_failed" }),
    ]);
  });

  it("sets aside the open governance proposal when the mode is set again", async () => {
    const deps = steeringMode("team");
    await run(deps, { mode: "solo" }, doubles());
    const again = await run(deps, { mode: "solo" }, doubles());
    expect(again.pullRequest).toMatchObject({ reused: true });
    expect(deps.store.proposals.map((p) => p.status)).toEqual([
      "rejected",
      "checks_passed",
    ]);
    // The open proposal names the PR's current head.
    expect(deps.store.proposals[1]?.headSha).toBe(
      await deps.github.branchHead(REPO, STEERING_BRANCH),
    );
    expect(deps.store.proposals[0]?.dismissedReason).toBe(
      "Replaced by a newer governance change on the same pull request",
    );
  });

  it("withdraws the open governance proposal and closes its PR when the mode in force is picked again", async () => {
    const deps = steeringMode("team");
    await run(deps, { mode: "solo" }, doubles());
    const pr = deps.github.pulls[0]!;

    const out = await run(deps, { mode: "team" }, doubles());

    expect(out).toMatchObject({ outcome: "unchanged", effectiveMode: "team" });
    // A reviewer can no longer land a mode nobody asked for now.
    expect(deps.store.proposals).toEqual([
      expect.objectContaining({
        kind: "governance",
        status: "rejected",
        dismissedReason: "Withdrawn: the mode it proposed was set back to the mode in force",
        updatedById: AUTHOR,
      }),
    ]);
    expect(pr.state).toBe("closed");
    expect(deps.github.deletedBranches).toContain(STEERING_BRANCH);
    expect(deps.events).toEqual([]);
  });

  it("replaces the open governance proposal with one that waits for its checks when the checker is down (negative)", async () => {
    const deps = steeringMode("team");
    await run(deps, { mode: "solo" }, doubles());
    const seams: SteeringGovernanceSeams = {
      ...doubles(),
      check: async () => {
        throw new Error("the steering checker is down");
      },
    };

    // A checker that does not answer reports a missing check on the PR, and
    // the call still records the change it pushed.
    const out = await run(deps, { mode: "solo" }, seams);
    expect(out.outcome).toBe("proposed");
    // The reused PR now carries the new head, so the old proposal no longer
    // names what would land. The replacement cannot land until its checks pass.
    expect(deps.store.proposals.at(-1)?.status).toBe("checks_failed");
    expect(
      deps.store.proposals.filter((p) => p.status === "checks_passed"),
    ).toHaveLength(0);
  });

  it("keeps the open governance proposal when a later call is refused (negative)", async () => {
    const deps = steeringMode("team");
    await run(deps, { mode: "solo" }, doubles());
    // The production branch turns on auto_merge, which only solo allows, so
    // team to regulated can no longer be written.
    const current = await productionText(deps);
    deps.github.commit(
      REPO.defaultBranch,
      STEERING_FILE,
      current.replace('mode = "team"', 'mode = "solo"').replace(
        "auto_merge = false",
        "auto_merge = true",
      ),
    );

    await expect(
      run(deps, { mode: "team" }, doubles()),
    ).rejects.toMatchObject({ reason: "governance_invalid" });
    expect(deps.store.proposals.map((p) => p.status)).toEqual([
      "checks_passed",
    ]);
  });

  it("reuses the open steering PR when the mode is set again", async () => {
    const deps = steeringMode("team");
    const first = await run(deps, { mode: "solo" }, doubles());

    const again = await run(deps, { mode: "solo" }, doubles());

    expect(again.outcome).toBe("proposed");
    expect(again.pullRequest).toEqual({
      number: first.pullRequest?.number,
      htmlUrl: first.pullRequest?.htmlUrl,
      reused: true,
    });
    expect(deps.github.pulls).toHaveLength(1);
    expect(deps.github.updates).toEqual([]);
  });

  it("brings a reused PR up to the production head before the checks run", async () => {
    const deps = steeringMode("team");
    await run(deps, { mode: "solo" }, doubles());
    const main = deps.github.commit(
      REPO.defaultBranch,
      "steering/platform/release-notes.md",
      "Every release has notes.\n",
    );
    const seams = doubles();

    const out = await run(deps, { mode: "solo" }, seams);

    expect(out.pullRequest).toMatchObject({ reused: true });
    expect(deps.github.updates).toEqual([
      expect.objectContaining({ branch: STEERING_BRANCH }),
    ]);
    expect(seams.checked).toEqual([
      { head: await deps.github.branchHead(REPO, STEERING_BRANCH), base: main },
    ]);
  });

  it("closes a reused PR that no longer merges and opens a fresh one", async () => {
    const deps = steeringMode("team");
    const first = await run(deps, { mode: "solo" }, doubles());
    // The production branch changes another line of the same file.
    const current = await productionText(deps);
    deps.github.commit(
      REPO.defaultBranch,
      STEERING_FILE,
      current.replace("max_lines = 10000", "max_lines = 5000"),
    );

    const out = await run(deps, { mode: "solo" }, doubles());

    expect(out.pullRequest).toMatchObject({ reused: false });
    expect(out.pullRequest?.number).not.toBe(first.pullRequest?.number);
    expect(deps.github.pulls.map((pr) => pr.state)).toEqual(["closed", "open"]);
    // The fresh PR keeps the production branch's other change.
    const branchText =
      (await deps.github.readFile(REPO, STEERING_FILE, STEERING_BRANCH)) ?? "";
    expect(branchText).toContain("max_lines = 5000");
    expect(branchText).toContain('mode = "solo"');
  });

  it("refuses to land when the checks fail, and leaves the PR open (negative)", async () => {
    const deps = steeringMode("solo");

    await expect(
      run(deps, { mode: "team" }, doubles(failed())),
    ).rejects.toMatchObject({ reason: "steering_check_failed" });

    expect(deps.github.merges).toEqual([]);
    expect(deps.github.pulls).toEqual([
      expect.objectContaining({ head: STEERING_BRANCH, state: "open" }),
    ]);
    expect(deps.github.checkRuns).toEqual([
      expect.objectContaining({ conclusion: "failure" }),
    ]);
    expect(deps.events).toEqual([]);
  });

  it("refuses a mode the rest of the file does not allow, before any write (negative)", async () => {
    // Memory auto-merge is allowed in solo only.
    const deps = steeringRepo((text) =>
      text
        .replace('mode = "team"', 'mode = "solo"')
        .replace("auto_merge = false", "auto_merge = true"),
    );

    await expect(
      run(deps, { mode: "team" }, doubles()),
    ).rejects.toMatchObject({ reason: "governance_invalid" });

    expect(deps.github.commits).toEqual([]);
    expect(deps.github.pulls).toEqual([]);
  });

  it("refuses a file it cannot read rather than guess the mode (negative)", async () => {
    const deps = steeringRepo((text) =>
      text.replace('mode = "team"', 'mode = "permissive"'),
    );

    await expect(
      run(deps, { mode: "solo" }, doubles()),
    ).rejects.toMatchObject({ reason: "governance_unreadable" });

    expect(deps.github.commits).toEqual([]);
    expect(deps.github.pulls).toEqual([]);
  });

  it("writes nothing when the file already declares the mode", async () => {
    const deps = steeringMode("team");

    const out = await run(deps, { mode: "team" }, doubles());

    expect(out).toMatchObject({
      outcome: "unchanged",
      effectiveMode: "team",
      path: STEERING_FILE,
      pullRequest: null,
    });
    expect(deps.github.commits).toEqual([]);
    expect(deps.github.pulls).toEqual([]);
    expect(deps.events).toEqual([]);
  });
});

// ── merge_context_pr on a governance proposal (#4795) ───────────────────────

/** The merge seams for a healthy steering repository, over `seams`' checks. */
function mergeSeams(
  seams: Doubles,
  over: Partial<MergeSeams> = {},
): MergeSeams {
  return {
    readHealth: async () => "healthy",
    governanceCheck: seams.check,
    publisher: () => fakePublisher(seams.published),
    ...over,
  };
}

/** Set team to solo through the review route, and answer its proposal id. */
async function proposeSolo(deps: Harness): Promise<string> {
  const out = await run(deps, { mode: "solo" }, doubles());
  expect(out.outcome).toBe("proposed");
  const row = deps.store.proposals.find((p) => p.status === "checks_passed");
  if (!row) throw new Error("no open governance proposal");
  return row.publicId;
}

describe("merge_context_pr on a governance proposal", () => {
  it("lands the reviewed change for an approver and refuses its author", async () => {
    const deps = steeringMode("team");
    const before = await productionText(deps);
    const proposalId = await proposeSolo(deps);
    const seams = doubles();
    const merge = createMergeContextPrHandler(deps, mergeSeams(seams));

    await expect(
      merge({ proposalId }, ctx({ userId: AUTHOR })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(deps.github.merges).toEqual([]);

    const out = await merge({ proposalId }, ctx({ userId: REVIEWER }));

    expect(out).toEqual({
      proposalId,
      status: "merged",
      kind: "governance",
      governance: { mode: "solo", path: STEERING_FILE },
      mergedCommit: deps.github.pulls[0]?.mergeCommitSha,
      bundleVersion: { before: 0, after: 0 },
      publishedVersion: 21,
    });
    expect(() => contextPrMerge.output.parse(out)).not.toThrow();
    expect(deps.github.merges).toHaveLength(1);
    expect(deps.github.merges[0]?.commitTitle).toBe(
      `steering: set governance mode to solo (#${deps.github.pulls[0]?.number})`,
    );
    expect(await productionText(deps)).toBe(
      before.replace('mode = "team"', 'mode = "solo"'),
    );
    // The ledger line names the approver, and nobody skipped review.
    expect(await lastLedgerLine(deps)).toMatchObject({
      approved_by: [REVIEWER],
      merged_by: REVIEWER,
      without_review: false,
    });
    // The merge publishes no record and appends no promotion event.
    expect(deps.store.records).toEqual([]);
    expect(deps.store.ledger).toEqual([]);
    expect(deps.store.proposals[0]).toMatchObject({
      status: "merged",
      mergedCommit: out.mergedCommit,
      mergedByUserId: REVIEWER,
      publishedRecordId: null,
      promotionEventId: null,
      mergeClaimedAt: null,
    });
    expect(seams.published).toEqual([out.mergedCommit]);
    expect(deps.github.deletedBranches).toContain(STEERING_BRANCH);
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
    ]);
    expect(deps.events[0]).toMatchObject({
      actorUserId: REVIEWER,
      capability: "merge_context_pr",
      detail: {
        previousMode: "team",
        mode: "solo",
        commitSha: out.mergedCommit,
        overrodeReview: false,
        approvedBy: [REVIEWER],
        proposalId,
      },
    });

    // The PR view says merged, with no promotion event and no record.
    const view = await createGetContextPrHandler(deps)(
      { proposalId },
      ctx({ userId: REVIEWER }),
    );
    expect(view).toMatchObject({
      status: "merged",
      record: null,
      body: STEERING_GOVERNANCE_PR_BODY,
      onMerge: { bundleVersion: { current: 0, afterMerge: 0 } },
      merged: {
        commit: out.mergedCommit,
        byUserId: REVIEWER,
        promotionEventId: null,
        recordId: null,
      },
    });
  });

  it("refuses a claimed governance merge when the host cannot authenticate its commit", async () => {
    const deps = steeringMode("team");
    const proposalId = await proposeSolo(deps);
    deps.store.proposals[0]!.mergeClaimedAt = new Date("2026-09-15T09:00:00.000Z");
    const mergeSha = deps.github.mergeOnHost(deps.github.pulls[0]!.number);
    const verify = vi.fn(async () => {
      throw new Error("The governance merge has no authenticated provenance.");
    });
    Object.assign(deps.github, { assertSteeringCommit: verify });
    const seams = doubles();

    await expect(
      createMergeContextPrHandler(deps, mergeSeams(seams))(
        { proposalId },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toThrow("The governance merge has no authenticated provenance.");

    expect(verify).toHaveBeenCalledWith(REPO, mergeSha);
    expect(deps.store.proposals[0]).toMatchObject({
      status: "checks_passed",
      mergedByUserId: null,
    });
    expect(deps.github.deletedBranches).toEqual([]);
    expect(deps.store.records).toEqual([]);
    expect(deps.store.ledger).toEqual([]);
    expect(seams.published).toEqual([]);
    expect(deps.events).toEqual([]);
  });

  it("answers the version an earlier call published when it resumes a merged PR", async () => {
    const deps = steeringMode("team");
    const proposalId = await proposeSolo(deps);
    // An earlier call claimed the row, merged and published the PR, then
    // failed before its record landed.
    deps.store.proposals[0]!.mergeClaimedAt = new Date("2026-09-15T09:00:00.000Z");
    const mergeSha = deps.github.mergeOnHost(deps.github.pulls[0]!.number);
    const seams = doubles();
    const published: SteeringPublisher = {
      ...fakePublisher(seams.published),
      store: {
        highestVersion: async () => 21,
        versionAt: async (_repository, commit) =>
          commit === mergeSha ? { version: 21, published: true } : null,
      },
    };

    const out = await createMergeContextPrHandler(
      deps,
      mergeSeams(seams, { publisher: () => published }),
    )({ proposalId }, ctx({ userId: REVIEWER }));

    expect(out).toMatchObject({
      kind: "governance",
      governance: { mode: "solo" },
      mergedCommit: mergeSha,
      publishedVersion: 21,
    });
    // The resume merges nothing twice.
    expect(deps.github.merges).toEqual([]);
  });

  it("refuses to finish a PR someone merged on the host, and leaves it to the sync (negative)", async () => {
    const deps = steeringMode("team");
    const proposalId = await proposeSolo(deps);
    deps.github.mergeOnHost(deps.github.pulls[0]!.number);
    deps.requestSync = vi.fn(async () => undefined);

    await expect(
      createMergeContextPrHandler(deps, mergeSeams(doubles()))({ proposalId }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ code: "conflict", reason: "merged_outside_oxagen" });
    // Nobody is credited with the merge, and no governance event claims a
    // review. The sync records it as a change made outside Oxagen.
    expect(deps.store.proposals[0]).toMatchObject({ status: "checks_passed", mergedByUserId: null });
    expect(deps.events).toEqual([]);
    expect(deps.requestSync).toHaveBeenCalledOnce();
  });

  it("brings a branch that fell behind up to date and runs the steering checks again", async () => {
    const deps = steeringMode("team");
    const proposalId = await proposeSolo(deps);
    const main = deps.github.commit(
      REPO.defaultBranch,
      "steering/platform/release-notes.md",
      "Every release has notes.\n",
    );
    const seams = doubles();

    const out = await createMergeContextPrHandler(deps, mergeSeams(seams))(
      { proposalId },
      ctx({ userId: REVIEWER }),
    );

    expect(out.kind).toBe("governance");
    expect(deps.github.updates).toEqual([
      expect.objectContaining({ branch: STEERING_BRANCH }),
    ]);
    // Once on the head the proposal holds, once on the updated head against
    // the production head it now holds.
    expect(seams.checked.map((c) => c.base)).toEqual([main, main]);
    expect(seams.checked[1]?.head).not.toBe(seams.checked[0]?.head);
    expect(deps.store.proposals[0]?.status).toBe("merged");
    expect(await lastLedgerLine(deps)).toMatchObject({
      approved_by: [REVIEWER],
      without_review: false,
    });
  });

  it("refuses a governance.toml that is not governance/v1, and merges nothing (negative)", async () => {
    const deps = steeringMode("team");
    const proposalId = await proposeSolo(deps);
    const text =
      (await deps.github.readFile(REPO, STEERING_FILE, STEERING_BRANCH)) ?? "";
    // auto_merge is allowed in solo mode only.
    const bad = deps.github.commit(
      STEERING_BRANCH,
      STEERING_FILE,
      text
        .replace('mode = "solo"', 'mode = "team"')
        .replace("auto_merge = false", "auto_merge = true"),
    );
    deps.store.proposals[0]!.headSha = bad;

    await expect(
      createMergeContextPrHandler(deps, mergeSeams(doubles()))(
        { proposalId },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ reason: "governance_invalid" });
    expect(deps.github.merges).toEqual([]);
    expect(deps.store.proposals[0]?.status).toBe("checks_passed");
    expect(deps.events).toEqual([]);
  });

  it("refuses when the steering checks fail on the head, and marks the proposal (negative)", async () => {
    const deps = steeringMode("team");
    const proposalId = await proposeSolo(deps);

    await expect(
      createMergeContextPrHandler(deps, mergeSeams(doubles(failed())))(
        { proposalId },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ reason: "checks_failed" });
    expect(deps.github.merges).toEqual([]);
    expect(deps.store.proposals[0]?.status).toBe("checks_failed");
  });

  it("refuses to land without an approval, even for a merger who may skip review (negative)", async () => {
    const deps = steeringMode("team");
    const proposalId = await proposeSolo(deps);
    deps.github.approvals = [];

    await expect(
      createMergeContextPrHandler(
        deps,
        mergeSeams(doubles(), { holdsMergeWithoutReview: async () => true }),
      )({ proposalId }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ reason: "review_required" });
    expect(deps.github.merges).toEqual([]);
    expect(deps.store.proposals[0]).toMatchObject({
      status: "checks_passed",
      mergeClaimedAt: null,
    });
    expect(deps.events.map((e) => e.eventType)).not.toContain(
      "steering.governance_overridden",
    );
  });

  it("refuses merge_pr_without_review on a governance proposal (negative)", async () => {
    const deps = steeringMode("team");
    const proposalId = await proposeSolo(deps);

    await expect(
      createMergeContextPrHandler(
        deps,
        mergeSeams(doubles()),
        contextPrMergeWithoutReview.name,
      )({ proposalId }, ctx({ userId: REVIEWER })),
    ).rejects.toMatchObject({ reason: "review_required" });
    expect(deps.github.merges).toEqual([]);
  });
});

// ── The repository sync on a governance change ──────────────────────────────

/**
 * The repository sync over the harness, with its clock past the merge grace,
 * after one baseline sync. The fake names the seed commit after its branch, so
 * a commit first gives the baseline a head of its own to compare against.
 */
async function syncedBaseline(
  deps: Harness,
  steeringVersionAt?: SyncDeps["steeringVersionAt"],
) {
  deps.github.commit(REPO.defaultBranch, "README.md", "The steering repo.");
  const syncDeps: SyncDeps = {
    github: deps.github,
    store: new MemorySyncStore(deps.store),
    steering: deps.store,
    now: () =>
      new Date(deps.now().getTime() + (MERGE_GRACE_SECONDS + 60) * 1000),
    emit: deps.emit,
    steeringVersionAt,
  };
  const sync = () => syncWorkspaceSteering(syncDeps, SCOPE);
  expect((await sync()).governanceChange).toBeNull();
  return sync;
}

/** The production branch's governance.toml with `from` swapped for `to`. */
async function pushMode(
  deps: Harness,
  from: string,
  to: string,
  message = `Set the mode to ${to}`,
) {
  const text = await productionText(deps);
  return deps.github.commit(
    REPO.defaultBranch,
    STEERING_FILE,
    text.replace(`mode = "${from}"`, `mode = "${to}"`),
    message,
  );
}

describe("the repository sync on a governance change", () => {
  it("records a governance PR merged on GitHub, and the proposal reads merged", async () => {
    const deps = steeringMode("team");
    const sync = await syncedBaseline(deps);
    const proposalId = await proposeSolo(deps);
    const pr = deps.github.pulls[0]!;
    const mergeSha = deps.github.mergeOnHost(pr.number);
    deps.events.length = 0;

    const out = await sync();

    expect(out.proposals.merged).toBe(1);
    const row = deps.store.proposals.find((p) => p.publicId === proposalId);
    expect(row).toMatchObject({
      status: "merged",
      mergedCommit: mergeSha,
      mergedByUserId: null,
      publishedRecordId: null,
      promotionEventId: null,
      mergeClaimedAt: null,
    });
    expect(deps.github.deletedBranches).toContain(STEERING_BRANCH);
    expect(out.governanceChange).toEqual({
      previousMode: "team",
      mode: "solo",
      commitSha: mergeSha,
      proposalId,
      pullRequest: row?.prUrl,
    });
    // Nobody approved it in Oxagen, and team asked for review, so the change
    // is recorded twice: as a change and as a skipped review.
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
      "steering.governance_overridden",
    ]);
    expect(deps.events[0]).toMatchObject({
      actorUserId: null,
      capability: null,
      workspaceId: SCOPE.workspaceId,
      detail: {
        previousMode: "team",
        mode: "solo",
        commitSha: mergeSha,
        overrodeReview: true,
        landedOutsideOxagen: true,
        proposalId,
        pullRequest: row?.prUrl,
      },
    });
    expect(deps.events[0]?.detail).not.toHaveProperty("approvedBy");
  });

  it("records a direct push that changes the mode, and names no proposal", async () => {
    const deps = steeringMode("team");
    const sync = await syncedBaseline(deps);
    const sha = await pushMode(deps, "team", "solo");

    const out = await sync();

    expect(out.governanceChange).toEqual({
      previousMode: "team",
      mode: "solo",
      commitSha: sha,
      proposalId: null,
      pullRequest: null,
    });
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
      "steering.governance_overridden",
    ]);
    expect(deps.events[0]?.detail).not.toHaveProperty("proposalId");
  });

  it("records a push whose commit forges an Oxagen-Version trailer (negative)", async () => {
    const deps = steeringMode("team");
    const sync = await syncedBaseline(deps);
    // Anyone who can push can write the trailer. No Oxagen record holds this
    // commit, so it is still a change made outside Oxagen.
    const sha = await pushMode(deps, "team", "solo", "Set the mode to solo\n\nOxagen-Version: 22");

    const out = await sync();

    expect(out.governanceChange).toMatchObject({ commitSha: sha, previousMode: "team", mode: "solo" });
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
      "steering.governance_overridden",
    ]);
  });

  it("records nothing for a commit whose trailer matches the version Oxagen stored at it", async () => {
    const deps = steeringMode("solo");
    let landed = "";
    // A solo change lands through the merge queue with no proposal, and the
    // version store holds its commit at the trailer's version.
    const sync = await syncedBaseline(deps, async (_scope, _repo, commitSha) =>
      commitSha === landed ? { version: 22 } : null,
    );
    landed = await pushMode(deps, "solo", "team", "steering: set governance mode to team\n\nOxagen-Version: 22");

    const out = await sync();

    expect(out.governanceChange).toBeNull();
    expect(deps.events).toEqual([]);
  });

  it("records a change away from solo as a change only, since solo asks for no review", async () => {
    const deps = steeringMode("solo");
    const sync = await syncedBaseline(deps);
    await pushMode(deps, "solo", "team");

    await sync();

    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
    ]);
    expect(deps.events[0]?.detail).toMatchObject({
      previousMode: "solo",
      mode: "team",
      overrodeReview: false,
      landedOutsideOxagen: true,
    });
  });

  it("records nothing for a change merge_context_pr landed, which recorded its own", async () => {
    const deps = steeringMode("team");
    const sync = await syncedBaseline(deps);
    const proposalId = await proposeSolo(deps);
    await createMergeContextPrHandler(deps, mergeSeams(doubles()))(
      { proposalId },
      ctx({ userId: REVIEWER }),
    );
    expect(deps.events.map((e) => e.eventType)).toEqual([
      "steering.governance_changed",
    ]);
    deps.events.length = 0;

    const out = await sync();

    expect(out.governanceChange).toBeNull();
    expect(deps.events).toEqual([]);
    // The sync leaves the proposal merge_context_pr landed as it was.
    expect(
      deps.store.proposals.find((p) => p.publicId === proposalId),
    ).toMatchObject({ status: "merged", mergedByUserId: REVIEWER });
  });

  it("records nothing for a push that leaves the mode alone (negative)", async () => {
    const deps = steeringMode("team");
    const sync = await syncedBaseline(deps);
    const text = await productionText(deps);
    deps.github.commit(
      REPO.defaultBranch,
      STEERING_FILE,
      `${text}\n# Reviewed on 2026-09-30.\n`,
    );

    const out = await sync();

    expect(out.governanceChange).toBeNull();
    expect(deps.events).toEqual([]);
  });
});
