// `set_governance_mode` against the steering doubles: which route a call takes,
// what reaches GitHub, and what is recorded.
//
// The route is the whole behaviour, and it is read off the file rather than
// asked for, so each of the four states the production branch can be in gets a
// case: solo (commit), team and regulated (pull request), and a governance.toml
// nothing can parse (pull request, because a mode nobody can establish must not
// be treated as the permissive one). The override takes the strict route back to
// the direct one and is recorded twice — once as a change, once as a skipped
// review — so that "every governance change" and "every skipped review" are each
// one event-type filter.
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { makeSetGovernanceModeHandler } from "./context.governance_mode.set";
import {
  AUTHOR,
  ctx,
  harness,
  REPO,
  type Harness,
} from "./context.steering.test-support";

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
) {
  const handler = makeSetGovernanceModeHandler(deps);
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
