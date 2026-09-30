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
// opens a steering PR. Solo and Apply now land it through the merge queue; the
// review route leaves it open and changes nothing yet (ADR-229, #4795).
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
import { makeSetGovernanceModeHandler } from "./context.governance_mode.set";
import {
  AUTHOR,
  ctx,
  harness,
  REPO,
  type Harness,
} from "./context.steering.test-support";
import {
  STEERING_GOVERNANCE_PR_BODY,
  type SteeringGovernanceSeams,
} from "./steering-repo/governance-mode";

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

/** Seams for a healthy repository whose publisher is at version 20. */
function doubles(report: CheckReport = passed()): Doubles {
  const checked: { head: string; base: string }[] = [];
  const published: string[] = [];
  const held = async (commit: string) => {
    published.push(commit);
    return { status: "current" as const, version: 21, commit };
  };
  return {
    checked,
    published,
    check: async (_scope, _host, _repo, head, base) => {
      checked.push({ head, base });
      return report;
    },
    readHealth: async () => "healthy",
    publisher: async () => ({
      repository: (repo) => repo.fullName,
      store: { highestVersion: async () => 20, versionAt: async () => null },
      publish: async (_repo, commit) => held(commit),
      withLock: (_repo, fn) => fn(held),
    }),
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
