// health.test.ts: the comparison, the report, and every state change a health
// read makes, against a scripted host and an in-memory health row.
import { GitHubApiError, GitHubRateLimitedError } from "@oxagen/github";
import type * as gh from "@oxagen/github/provision";
import { EXAMPLE_GITHUB_BASELINE } from "@oxagen/github/provision/testing";
import * as gl from "@oxagen/gitlab/provision";
import { GITLAB_SETTINGS_BASELINE } from "@oxagen/oxagen/steering-repo";
import type { SettingsDifference } from "@oxagen/oxagen/steering-repo/health";
import { describe, expect, it, vi } from "vitest";
import {
  attribute,
  canonical,
  checkRepoHealth,
  compare,
  decideHealth,
  describeDifference,
  displaySettingValue,
  type Divergence,
  HEALTH_COMMENT_MARKER,
  HEALTH_REQUESTED_EVENT,
  type HealthDeps,
  type HealthHost,
  type HealthRow,
  type HealthScope,
  type HealthState,
  type HealthTarget,
  type HealthTrigger,
  healthDigest,
  healthKey,
  healthRequests,
  isRateLimited,
  type Observation,
  type OpenPullRequest,
  type PublishedCommit,
  RECOVERY_COMMENT,
  type RawDifference,
  renderHealthReport,
  requiresCheck,
  SWEEP_TRIGGER,
  settingDifferences,
} from "./health";

// ── Settings as the hosts report them ────────────────────────────────────────

/** GitHub settings that match the baseline, as `readSettings` reports them. */
function githubMatching(): gh.ObservedGithubSettings {
  const b = EXAMPLE_GITHUB_BASELINE;
  return {
    visibility: b.visibility,
    default_branch: b.default_branch,
    rulesets: Object.fromEntries(
      Object.entries(b.rulesets).map(([key, r], index) => [
        key,
        {
          id: index + 1,
          name: r.name,
          target: r.target,
          enforcement: r.enforcement,
          include: [...r.include],
          bypass_actors: r.bypass_actors.map((a) => ({
            actor: a.actor,
            bypass_mode: a.bypass_mode,
          })),
          rules: JSON.parse(JSON.stringify(r.rules)) as gh.ObservedRuleset["rules"],
        },
      ]),
    ),
    merge: { ...b.merge },
    actions: { ...b.actions },
    environments: Object.fromEntries(
      Object.entries(b.environments).map(([name, e]) => [
        name,
        { deployment_branches: [...e.deployment_branches], deployed_by: e.deployed_by },
      ]),
    ),
  };
}

const BOT: gl.SteeringBot = { symbol: "oxagen-steering", user_id: 77, username: "oxagen-bot" };

/** GitLab settings that match the baseline, as `readGitlabSettings` reports them. */
function gitlabMatching(): gl.ObservedGitlabSettings {
  const b = GITLAB_SETTINGS_BASELINE;
  return {
    visibility: b.visibility,
    default_branch: b.default_branch,
    protected_branches: {
      main: { push_access: "no_one", merge_access: `user:${BOT.user_id}`, allow_force_push: false },
    },
    merge_requests: {
      squash_option: b.merge_requests.squash_option,
      only_allow_merge_if_pipeline_succeeds: b.merge_requests.only_allow_merge_if_pipeline_succeeds,
      remove_source_branch_after_merge: b.merge_requests.remove_source_branch_after_merge,
      reset_approvals_on_push: b.merge_requests.reset_approvals_on_push,
    },
    ci_cd: { builds_access_level: b.ci_cd.builds_access_level },
  };
}

function github(actual: gh.ObservedGithubSettings) {
  return { provider: "github" as const, baseline: EXAMPLE_GITHUB_BASELINE, actual };
}

// ── Comparison ───────────────────────────────────────────────────────────────

describe("settingDifferences", () => {
  it("finds nothing when GitHub holds the baseline", () => {
    expect(settingDifferences(github(githubMatching()))).toEqual([]);
  });

  it("finds nothing when GitLab holds the baseline", () => {
    expect(
      settingDifferences({
        provider: "gitlab",
        baseline: GITLAB_SETTINGS_BASELINE,
        actual: gitlabMatching(),
        bot: BOT,
      }),
    ).toEqual([]);
  });

  it("reads a deleted ruleset as null and sorts by setting", () => {
    const actual = githubMatching();
    delete actual.rulesets.oxagen_merges;
    actual.merge.allow_rebase_merge = true;
    expect(settingDifferences(github(actual))).toEqual([
      { setting: "merge.allow_rebase_merge", expected: false, actual: true },
      { setting: "rulesets.oxagen_merges", expected: "Oxagen merges", actual: null },
    ]);
  });

  it("folds a ruleset that lost the required check into one rules entry", () => {
    const actual = githubMatching();
    const steering = actual.rulesets.oxagen_steering;
    if (steering === undefined) throw new Error("the baseline names oxagen_steering");
    steering.rules = steering.rules.filter((r) => r.type !== "required_status_checks");
    const differences = settingDifferences(github(actual));
    expect(differences).toHaveLength(1);
    const [only] = differences;
    expect(only?.setting).toBe("rulesets.oxagen_steering.rules");
    expect(requiresCheck(only?.expected)).toBe(true);
    expect(requiresCheck(only?.actual)).toBe(false);
  });

  it("ignores who recorded the last deployment", () => {
    const actual = githubMatching();
    const env = actual.environments.steering;
    if (env === undefined) throw new Error("the baseline names the steering environment");
    env.deployed_by = "someone-else";
    expect(settingDifferences(github(actual))).toEqual([]);
  });

  it("reads a GitLab branch that allows force pushes", () => {
    const actual = gitlabMatching();
    const main = actual.protected_branches.main;
    if (main === undefined) throw new Error("main is protected");
    main.allow_force_push = true;
    expect(
      settingDifferences({
        provider: "gitlab",
        baseline: GITLAB_SETTINGS_BASELINE,
        actual,
        bot: BOT,
      }),
    ).toEqual([
      { setting: "protected_branches.main.allow_force_push", expected: false, actual: true },
    ]);
  });
});

const RULESET_DELETED: HealthTrigger = {
  reason: "repository_ruleset.deleted",
  actor: "octocat",
  at: "2026-09-27T10:05:12Z",
  settings: ["rulesets.oxagen_merges"],
  pull_request: null,
};

describe("compare", () => {
  const actual = githubMatching();
  delete actual.rulesets.oxagen_merges;
  actual.merge.allow_rebase_merge = true;

  it("attributes only the settings the event names", () => {
    expect(compare(github(actual), [], RULESET_DELETED)).toEqual([
      {
        setting: "merge.allow_rebase_merge",
        expected: false,
        actual: true,
        changed_by: null,
        changed_at: null,
      },
      {
        setting: "rulesets.oxagen_merges",
        expected: "Oxagen merges",
        actual: null,
        changed_by: "octocat",
        changed_at: "2026-09-27T10:05:12.000Z",
      },
    ]);
  });

  it("keeps what the last read recorded while the value stays the same", () => {
    const first = compare(github(actual), [], RULESET_DELETED);
    expect(compare(github(actual), first)).toEqual(first);
  });

  it("drops the old attribution when the value changes again", () => {
    const previous: SettingsDifference[] = [
      {
        setting: "merge.allow_rebase_merge",
        expected: false,
        actual: "something else",
        changed_by: "old",
        changed_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    const [rebase] = compare(github(actual), previous);
    expect(rebase).toMatchObject({ changed_by: null, changed_at: null });
  });

  it("matches a setting under a path the event names", () => {
    const raw: RawDifference[] = [
      { setting: "rulesets.oxagen_steering.enforcement", expected: "active", actual: "disabled" },
    ];
    const [d] = attribute(raw, [], { ...RULESET_DELETED, settings: ["rulesets.oxagen_steering"] });
    expect(d?.changed_by).toBe("octocat");
  });

  it("drops a time it cannot read", () => {
    const raw: RawDifference[] = [
      { setting: "rulesets.oxagen_merges", expected: "Oxagen merges", actual: null },
    ];
    const [d] = attribute(raw, [], { ...RULESET_DELETED, at: "yesterday" });
    expect(d).toMatchObject({ changed_by: "octocat", changed_at: null });
  });
});

describe("decideHealth", () => {
  it("ranks lost access over history, and history over settings", () => {
    expect(decideHealth({ disconnected: true, diverged: true, differences: 3 })).toBe(
      "disconnected",
    );
    expect(decideHealth({ disconnected: false, diverged: true, differences: 3 })).toBe(
      "diverged",
    );
    expect(decideHealth({ disconnected: false, diverged: false, differences: 3 })).toBe(
      "drifted",
    );
    expect(decideHealth({ disconnected: false, diverged: false, differences: 0 })).toBe(
      "healthy",
    );
  });
});

// ── Report ───────────────────────────────────────────────────────────────────

function difference(over: Partial<SettingsDifference> & { setting: string }): SettingsDifference {
  return { expected: null, actual: null, changed_by: null, changed_at: null, ...over };
}

function state(over: Partial<HealthState>): HealthState {
  return {
    provider: "github",
    health: "drifted",
    differences: [],
    reason: null,
    published_version: 7,
    revert_pr_number: null,
    ...over,
  };
}

describe("describeDifference", () => {
  it("names each kind of change in plain words", () => {
    expect(
      describeDifference(difference({ setting: "rulesets.oxagen_merges", expected: "Oxagen merges" })),
    ).toBe('ruleset "Oxagen merges" was deleted');
    expect(
      describeDifference(difference({ setting: "rulesets.oxagen_steering.rules.deletion" })),
    ).toBe('ruleset "Oxagen steering" lost its deletion rule');
    expect(
      describeDifference(
        difference({
          setting: "rulesets.oxagen_steering.enforcement",
          expected: "active",
          actual: "disabled",
        }),
      ),
    ).toBe('ruleset "Oxagen steering" changed: enforcement is "disabled", expected "active"');
    expect(describeDifference(difference({ setting: "environments.steering" }))).toBe(
      'environment "steering" was deleted',
    );
    expect(describeDifference(difference({ setting: "protected_branches.main" }))).toBe(
      "branch main is no longer protected",
    );
    expect(
      describeDifference(
        difference({ setting: "protected_branches.main.allow_force_push", actual: true }),
      ),
    ).toBe("branch main allows force pushes");
    expect(describeDifference(difference({ setting: "actions.enabled", actual: true }))).toBe(
      "GitHub Actions is on",
    );
    expect(
      describeDifference(difference({ setting: "ci_cd.builds_access_level", actual: "enabled" })),
    ).toBe("CI/CD is on");
    expect(
      describeDifference(
        difference({ setting: "visibility", expected: "private", actual: "public" }),
      ),
    ).toBe('the repository is "public", expected "private"');
    expect(
      describeDifference(
        difference({ setting: "default_branch", expected: "main", actual: "trunk" }),
      ),
    ).toBe('the default branch is "trunk", expected "main"');
    expect(
      describeDifference(
        difference({ setting: "merge.allow_rebase_merge", expected: false, actual: true }),
      ),
    ).toBe("merge.allow_rebase_merge is true, expected false");
  });

  it("says a ruleset no longer requires the check", () => {
    const rules = EXAMPLE_GITHUB_BASELINE.rulesets.oxagen_steering?.rules ?? [];
    expect(
      describeDifference(
        difference({
          setting: "rulesets.oxagen_steering.rules",
          expected: rules,
          actual: rules.filter((r) => r.type !== "required_status_checks"),
        }),
      ),
    ).toBe('ruleset "Oxagen steering" no longer requires the check "Oxagen steering"');
  });
});

describe("displaySettingValue", () => {
  it("shows unset, JSON, and a long value cut to 120 characters", () => {
    expect(displaySettingValue(null)).toBe("unset");
    expect(displaySettingValue(undefined)).toBe("unset");
    expect(displaySettingValue("private")).toBe('"private"');
    const long = displaySettingValue("x".repeat(200));
    expect(long).toHaveLength(120);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("renderHealthReport", () => {
  const deleted = difference({
    setting: "rulesets.oxagen_merges",
    expected: "Oxagen merges",
    changed_by: "octocat",
    changed_at: "2026-09-27T10:05:12.000Z",
  });

  it("lists each difference with who changed it and when", () => {
    const report = renderHealthReport(state({ differences: [deleted] }));
    expect(report.title).toBe("Repository settings changed");
    expect(report.summary).toContain(
      '✗ ruleset "Oxagen merges" was deleted (2026-09-27 10:05 UTC, by @octocat)',
    );
    expect(report.summary).toContain("Runs keep using published version 7.");
    expect(report.summary).toContain("Repair settings");
    expect(report.comment.startsWith(HEALTH_COMMENT_MARKER)).toBe(true);
    expect(report.comment).toContain("**Oxagen steering** failed: Repository settings changed");
  });

  it("shows whichever of time and actor the event gave", () => {
    const at = renderHealthReport(
      state({ differences: [{ ...deleted, changed_by: null }], published_version: null }),
    );
    expect(at.summary).toContain("was deleted (2026-09-27 10:05 UTC)\n");
    expect(at.summary).toContain("Runs keep using the last published version.");
    const by = renderHealthReport(state({ differences: [{ ...deleted, changed_at: null }] }));
    expect(by.summary).toContain("was deleted (by @octocat)\n");
  });

  it("says who must reconnect a disconnected repo", () => {
    const report = renderHealthReport(
      state({ health: "disconnected", reason: "The Oxagen GitHub App is no longer installed on acme." }),
    );
    expect(report.title).toBe("Oxagen lost access to the repository");
    expect(report.summary).toContain("✗ The Oxagen GitHub App is no longer installed on acme.");
    expect(report.summary).toContain("an organization admin connects the repository");
  });

  it("names the revert pull request of a diverged repo", () => {
    const report = renderHealthReport(
      state({
        health: "diverged",
        reason: "main holds 1 commit that no pull request merged: c3c3c3c",
        revert_pr_number: 13,
      }),
    );
    expect(report.title).toBe("main holds a commit that no pull request merged");
    expect(report.summary).toContain("✗ main holds 1 commit that no pull request merged: c3c3c3c");
    expect(report.summary).toContain("which merges #13");
  });

  it("says when the revert pull request could not be opened", () => {
    const report = renderHealthReport(state({ health: "diverged", reason: "x" }));
    expect(report.summary).toContain("Oxagen could not open the pull request that reverts main");
  });

  it("renders the recovery comment for a healthy repo", () => {
    const report = renderHealthReport(state({ health: "healthy" }));
    expect(report.comment).toBe(RECOVERY_COMMENT);
  });
});

describe("healthDigest", () => {
  it("changes with anything the report shows", () => {
    const visibility = difference({ setting: "visibility", expected: "private", actual: "public" });
    const base = state({ differences: [visibility] });
    const variants: HealthState[] = [
      state({ differences: [{ ...visibility, actual: "internal" }] }),
      state({ differences: [{ ...visibility, expected: "internal" }] }),
      state({ differences: [{ ...visibility, changed_by: "octocat" }] }),
      state({ differences: [{ ...visibility, changed_at: "2026-09-27T10:05:12.000Z" }] }),
      { ...base, health: "diverged" },
      { ...base, reason: "x" },
      { ...base, revert_pr_number: 4 },
      { ...base, published_version: 8 },
    ];
    for (const variant of variants) expect(healthDigest(variant)).not.toBe(healthDigest(base));
    expect(healthDigest(state({ differences: [{ ...visibility }] }))).toBe(healthDigest(base));
  });

  it("sorts keys, so equal values compare equal", () => {
    expect(canonical({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe(
      canonical({ a: [2, { c: 3 }], b: 1 }),
    );
    expect(canonical(undefined)).toBe("null");
  });
});

describe("healthRequests", () => {
  it("sends one event per scope, keyed by organization and workspace", () => {
    const scopes: HealthScope[] = [
      { orgId: "o1", workspaceId: null },
      { orgId: "o1", workspaceId: "w1" },
    ];
    expect(healthKey(scopes[0] as HealthScope)).toBe("o1:org");
    expect(healthRequests(scopes, SWEEP_TRIGGER)).toEqual([
      {
        name: HEALTH_REQUESTED_EVENT,
        data: { orgId: "o1", workspaceId: null, key: "o1:org", trigger: SWEEP_TRIGGER },
      },
      {
        name: HEALTH_REQUESTED_EVENT,
        data: { orgId: "o1", workspaceId: "w1", key: "o1:w1", trigger: SWEEP_TRIGGER },
      },
    ]);
  });
});

describe("isRateLimited", () => {
  it("knows both hosts' rate limits and nothing else", () => {
    expect(isRateLimited(new GitHubRateLimitedError(429, "slow", 1000))).toBe(true);
    expect(isRateLimited(new gl.GitLabRateLimitedError(429, "slow", 1000))).toBe(true);
    expect(isRateLimited(new GitHubApiError(403, "no"))).toBe(false);
    expect(isRateLimited(new Error("boom"))).toBe(false);
  });
});

// ── The run ──────────────────────────────────────────────────────────────────

const SCOPE: HealthScope = { orgId: "org-1", workspaceId: "ws-1" };
const TARGET: HealthTarget = {
  scope: SCOPE,
  provider: "github",
  repository: { id: 4242, full_name: "acme/steering" },
  deepLink: "/acme/main/repositories",
};

const P = "a1".repeat(20);
const PUBLISHED: PublishedCommit = { sha: P, version: 7 };
const DIVERGENCE: Divergence = {
  reason: "main holds 1 commit that no pull request merged: c3c3c3c",
  main_sha: "d4".repeat(20),
};

const PR1: OpenPullRequest = { number: 11, head_sha: "11".repeat(20), head_ref: "oxagen/rule-a" };
const PR2: OpenPullRequest = { number: 12, head_sha: "12".repeat(20), head_ref: "oxagen/rule-b" };
const REVERT_PR: OpenPullRequest = {
  number: 13,
  head_sha: "13".repeat(20),
  head_ref: "steering/revert-to-a1a1a1a-d4d4d4d",
};

const CLEAN: Observation = { kind: "connected", repository: "acme/steering", differences: [] };
const MERGES_DIFFERENCE: RawDifference = {
  setting: "rulesets.oxagen_merges",
  expected: "Oxagen merges",
  actual: null,
};
const MERGES_DELETED: Observation = {
  kind: "connected",
  repository: "acme/steering",
  differences: [MERGES_DIFFERENCE],
};
const UNINSTALLED: Observation = {
  kind: "disconnected",
  reason: "The Oxagen GitHub App is no longer installed on acme.",
};

/** What the scripted host answers. Each field can change between reads. */
interface Script {
  observation: Observation | (() => Promise<Observation>);
  published: PublishedCommit | null | (() => Promise<PublishedCommit | null>);
  divergence: Divergence | null;
  revert: number | (() => Promise<number>);
  prs: OpenPullRequest[] | (() => Promise<OpenPullRequest[]>);
  /** False when the host holds more open pull requests than it listed. */
  complete?: boolean;
  failCheck: (pr: OpenPullRequest) => Promise<void>;
}

function answer<T>(value: T | (() => Promise<T>)): Promise<T> {
  return typeof value === "function" ? (value as () => Promise<T>)() : Promise.resolve(value);
}

function scriptedHost(script: Script) {
  return {
    observe: vi.fn(() => answer(script.observation)),
    published: vi.fn(() => answer(script.published)),
    diverged: vi.fn(async (_published: PublishedCommit) => script.divergence),
    openRevert: vi.fn(
      (_published: PublishedCommit, _divergence: Divergence, _previous: number | null) =>
        answer(script.revert),
    ),
    closeRevert: vi.fn(async (_number: number) => {}),
    isRevert: (pr: OpenPullRequest) => pr.head_ref.startsWith("steering/revert-to-"),
    openPullRequests: vi.fn(async () => ({
      pulls: await answer(script.prs),
      complete: script.complete ?? true,
    })),
    failCheck: vi.fn((pr: OpenPullRequest, _report: unknown) => script.failCheck(pr)),
    restoreCheck: vi.fn(async (_pr: OpenPullRequest) => {}),
    upsertComment: vi.fn(
      async (_pr: OpenPullRequest, _body: string, _onlyIfExists: boolean) => {},
    ),
  } satisfies HealthHost;
}

/** A health read against one scripted host, with the row kept in memory. */
function rig(over: Partial<Script> = {}) {
  const script: Script = {
    observation: CLEAN,
    published: PUBLISHED,
    divergence: null,
    revert: 13,
    prs: [PR1, PR2],
    failCheck: async () => {},
    ...over,
  };
  const host = scriptedHost(script);
  let row: HealthRow | null = null;
  let clock = new Date("2026-09-27T10:00:00.000Z");
  const saves: HealthRow[] = [];
  const notify = vi.fn(async (_t: HealthTarget, _s: HealthState, _r: unknown) => {});
  const deps: HealthDeps = {
    now: () => clock,
    loadTarget: async () => TARGET,
    loadRow: async () => (row === null ? null : structuredClone(row)),
    saveRow: async (_scope, next) => {
      row = structuredClone(next);
      saves.push(structuredClone(next));
    },
    host: async () => host,
    notify,
  };
  return {
    script,
    host,
    deps,
    notify,
    saves,
    row: () => row,
    tick: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * 60_000);
    },
    read: (trigger: HealthTrigger = SWEEP_TRIGGER) => checkRepoHealth(deps, SCOPE, trigger),
    reset: () => {
      vi.clearAllMocks();
      saves.length = 0;
    },
  };
}

describe("checkRepoHealth", () => {
  it("returns null when the scope has no ready steering repo", async () => {
    const r = rig();
    r.deps.loadTarget = async () => null;
    expect(await r.read()).toBeNull();
    expect(r.host.observe).not.toHaveBeenCalled();
  });

  it("returns null when this deployment cannot reach the host", async () => {
    const r = rig();
    r.deps.host = async () => null;
    expect(await r.read()).toBeNull();
    expect(r.saves).toEqual([]);
  });

  it("records a healthy first read without posting or notifying", async () => {
    const r = rig();
    const outcome = await r.read();
    expect(outcome).toEqual({
      health: "healthy",
      previous: null,
      differences: [],
      reason: null,
      posted: 0,
      restored: 0,
      notified: false,
    });
    expect(r.row()).toMatchObject({
      provider: "github",
      repositoryId: 4242,
      repository: "acme/steering",
      health: "healthy",
      publishedSha: P,
      publishedVersion: 7,
      revertPrNumber: null,
      notifiedHealth: "healthy",
      postedDigest: null,
    });
    expect(r.host.openPullRequests).not.toHaveBeenCalled();
    expect(r.notify).not.toHaveBeenCalled();
  });

  it("goes from healthy to drifted: fails every pull request, comments, and notifies once", async () => {
    const r = rig();
    await r.read();
    r.reset();
    r.tick(5);
    r.script.observation = MERGES_DELETED;
    const outcome = await r.read(RULESET_DELETED);

    expect(outcome).toMatchObject({ health: "drifted", previous: "healthy", posted: 2, notified: true });
    expect(outcome?.differences).toEqual([
      {
        setting: "rulesets.oxagen_merges",
        expected: "Oxagen merges",
        actual: null,
        changed_by: "octocat",
        changed_at: "2026-09-27T10:05:12.000Z",
      },
    ]);
    expect(r.host.failCheck.mock.calls.map(([pr]) => pr.number)).toEqual([11, 12]);
    const [, report] = r.host.failCheck.mock.calls[0] ?? [];
    expect(report).toMatchObject({ title: "Repository settings changed" });
    expect(r.host.upsertComment).toHaveBeenCalledTimes(2);
    const [pr, body, onlyIfExists] = r.host.upsertComment.mock.calls[0] ?? [];
    expect(pr?.number).toBe(11);
    expect(body).toContain(HEALTH_COMMENT_MARKER);
    expect(body).toContain("(2026-09-27 10:05 UTC, by @octocat)");
    expect(onlyIfExists).toBe(false);

    expect(r.notify).toHaveBeenCalledTimes(1);
    expect(r.notify.mock.calls[0]?.[1].health).toBe("drifted");

    // The guards see the state before any pull request does.
    expect(r.saves[0]?.health).toBe("drifted");
    expect(r.saves[0]?.postedDigest).toBeNull();
    expect(r.row()).toMatchObject({
      health: "drifted",
      notifiedHealth: "drifted",
      changedAt: new Date("2026-09-27T10:05:00.000Z"),
    });
    expect(r.row()?.postedDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("posts nothing more on a sweep while the report is unchanged", async () => {
    const r = rig({ observation: MERGES_DELETED });
    await r.read(RULESET_DELETED);
    const first = r.row();
    r.reset();
    r.tick(10);
    const outcome = await r.read();

    expect(outcome).toMatchObject({ health: "drifted", previous: "drifted", posted: 0, notified: false });
    expect(r.host.openPullRequests).not.toHaveBeenCalled();
    expect(r.host.failCheck).not.toHaveBeenCalled();
    expect(r.notify).not.toHaveBeenCalled();
    // The sweep keeps the event's attribution and the time the state began.
    expect(r.row()?.differences).toEqual(first?.differences);
    expect(r.row()?.changedAt).toEqual(first?.changedAt);
    expect(r.row()?.checkedAt).toEqual(new Date("2026-09-27T10:10:00.000Z"));
  });

  it("fails only the pull request that opened while the report is unchanged", async () => {
    const r = rig({ observation: MERGES_DELETED });
    await r.read(RULESET_DELETED);
    r.reset();
    const opened: HealthTrigger = {
      reason: "pull_request.opened",
      actor: "someone",
      at: "2026-09-27T10:07:00Z",
      settings: [],
      pull_request: { number: 12, head_sha: PR2.head_sha },
    };
    const outcome = await r.read(opened);
    expect(outcome?.posted).toBe(1);
    expect(r.host.failCheck.mock.calls.map(([pr]) => pr.number)).toEqual([12]);
  });

  it("posts on every pull request again when the report changes", async () => {
    const r = rig({ observation: MERGES_DELETED });
    await r.read(RULESET_DELETED);
    r.reset();
    r.script.observation = {
      ...MERGES_DELETED,
      differences: [
        MERGES_DIFFERENCE,
        { setting: "actions.enabled", expected: false, actual: true },
      ],
    };
    const outcome = await r.read();
    expect(outcome?.posted).toBe(2);
    expect(r.notify).not.toHaveBeenCalled();
  });

  it("goes from drifted to healthy: restores each check, edits the comments, and notifies", async () => {
    const r = rig({ observation: MERGES_DELETED });
    await r.read(RULESET_DELETED);
    r.reset();
    r.tick(3);
    r.script.observation = CLEAN;
    const outcome = await r.read();

    expect(outcome).toMatchObject({ health: "healthy", previous: "drifted", restored: 2, notified: true });
    expect(r.host.restoreCheck.mock.calls.map(([pr]) => pr.number)).toEqual([11, 12]);
    expect(r.host.upsertComment.mock.calls).toEqual([
      [PR1, RECOVERY_COMMENT, true],
      [PR2, RECOVERY_COMMENT, true],
    ]);
    expect(r.notify.mock.calls[0]?.[1].health).toBe("healthy");
    expect(r.row()).toMatchObject({ health: "healthy", notifiedHealth: "healthy", postedDigest: null });

    // The next healthy read has nothing to put back.
    r.reset();
    await r.read();
    expect(r.host.openPullRequests).not.toHaveBeenCalled();
  });

  it("goes disconnected: keeps the name, skips history, and moves past refused posts", async () => {
    const r = rig();
    await r.read();
    r.reset();
    r.script.observation = UNINSTALLED;
    r.script.failCheck = async () => {
      throw new GitHubApiError(403, "Resource not accessible by integration");
    };
    const outcome = await r.read({ ...SWEEP_TRIGGER, reason: "installation.deleted" });

    expect(outcome).toMatchObject({
      health: "disconnected",
      reason: "The Oxagen GitHub App is no longer installed on acme.",
      posted: 0,
      notified: true,
    });
    expect(r.host.published).not.toHaveBeenCalled();
    expect(r.host.failCheck).toHaveBeenCalledTimes(2);
    expect(r.row()).toMatchObject({
      health: "disconnected",
      repository: "acme/steering",
      publishedSha: P,
      publishedVersion: 7,
    });
    expect(r.notify.mock.calls[0]?.[2]).toMatchObject({
      title: "Oxagen lost access to the repository",
    });
  });

  it("goes diverged: opens the revert, skips it, and names it in the report", async () => {
    const r = rig({ prs: [PR1, REVERT_PR, PR2] });
    await r.read();
    r.reset();
    r.script.divergence = DIVERGENCE;
    const outcome = await r.read({ ...SWEEP_TRIGGER, reason: "push" });

    expect(outcome).toMatchObject({ health: "diverged", reason: DIVERGENCE.reason, posted: 2 });
    expect(r.host.openRevert).toHaveBeenCalledWith(PUBLISHED, DIVERGENCE, null);
    expect(r.host.failCheck.mock.calls.map(([pr]) => pr.number)).toEqual([11, 12]);
    const [, report] = r.host.failCheck.mock.calls[0] ?? [];
    expect((report as { summary: string }).summary).toContain("which merges #13");
    expect(r.row()).toMatchObject({ health: "diverged", revertPrNumber: 13, publishedSha: P });
  });

  it("keeps settings differences in the report of a diverged repo", async () => {
    const r = rig({ observation: MERGES_DELETED, divergence: DIVERGENCE });
    const outcome = await r.read();
    expect(outcome?.health).toBe("diverged");
    expect(outcome?.differences).toHaveLength(1);
    const [, report] = r.host.failCheck.mock.calls[0] ?? [];
    expect((report as { summary: string }).summary).toContain('ruleset "Oxagen merges" was deleted');
  });

  it("passes the open revert to the next read, which keeps it", async () => {
    const r = rig({ divergence: DIVERGENCE });
    await r.read();
    r.reset();
    await r.read();
    expect(r.host.openRevert).toHaveBeenCalledWith(PUBLISHED, DIVERGENCE, 13);
  });

  it("goes from diverged to healthy: closes the revert pull request", async () => {
    const r = rig({ divergence: DIVERGENCE });
    await r.read();
    r.reset();
    r.script.divergence = null;
    const outcome = await r.read({ ...SWEEP_TRIGGER, reason: "push" });

    expect(outcome).toMatchObject({ health: "healthy", previous: "diverged", notified: true });
    expect(r.host.closeRevert).toHaveBeenCalledWith(13);
    expect(r.row()).toMatchObject({ health: "healthy", revertPrNumber: null });
  });

  it("stays healthy when closing an old revert fails", async () => {
    const r = rig({ divergence: DIVERGENCE });
    await r.read();
    r.reset();
    r.script.divergence = null;
    r.host.closeRevert.mockRejectedValueOnce(new Error("already merged"));
    expect((await r.read())?.health).toBe("healthy");
    expect(r.row()?.revertPrNumber).toBeNull();
  });

  it("stays diverged when the revert cannot be opened, and says so", async () => {
    const r = rig({
      divergence: DIVERGENCE,
      revert: async () => {
        throw new GitHubApiError(422, "Reference already exists");
      },
    });
    const outcome = await r.read();
    expect(outcome?.health).toBe("diverged");
    expect(r.row()?.revertPrNumber).toBeNull();
    const [, report] = r.host.failCheck.mock.calls[0] ?? [];
    expect((report as { summary: string }).summary).toContain(
      "Oxagen could not open the pull request that reverts main",
    );
  });

  it("keeps a diverged repo diverged when the history read fails", async () => {
    const r = rig({ divergence: DIVERGENCE });
    await r.read();
    r.reset();
    r.script.published = async () => {
      throw new Error("GitHub answered 502");
    };
    const outcome = await r.read();
    expect(outcome).toMatchObject({ health: "diverged", reason: DIVERGENCE.reason, notified: false });
    expect(r.host.openRevert).not.toHaveBeenCalled();
    expect(r.host.closeRevert).not.toHaveBeenCalled();
    expect(r.row()).toMatchObject({ revertPrNumber: 13, publishedSha: P, publishedVersion: 7 });
  });

  it("refuses a healthy GitHub repo when its commit history cannot be verified", async () => {
    const r = rig({
      published: async () => {
        throw new Error("GitHub answered 502");
      },
    });
    expect(await r.read()).toMatchObject({
      health: "diverged",
      reason: "Oxagen could not verify this steering repository's commit history. Retry the health check.",
    });
    expect(r.host.openRevert).not.toHaveBeenCalled();
  });

  it("refuses GitHub history without an authenticated published commit", async () => {
    const r = rig({ published: null, divergence: DIVERGENCE });
    expect(await r.read()).toMatchObject({
      health: "diverged",
      reason: "Oxagen could not find an authenticated published commit for this steering repository.",
    });
    expect(r.host.openRevert).not.toHaveBeenCalled();
    expect(r.host.diverged).not.toHaveBeenCalled();
    expect(r.row()?.publishedSha).toBeNull();
  });

  it("rethrows a rate limit on the settings read and stores nothing", async () => {
    const r = rig({
      observation: async () => {
        throw new GitHubRateLimitedError(429, "API rate limit exceeded", 60_000);
      },
    });
    await expect(r.read()).rejects.toBeInstanceOf(GitHubRateLimitedError);
    expect(r.saves).toEqual([]);
  });

  it("rethrows a rate limit on the history read", async () => {
    const r = rig({
      published: async () => {
        throw new gl.GitLabRateLimitedError(429, "Retry later", 1_000);
      },
    });
    await expect(r.read()).rejects.toBeInstanceOf(gl.GitLabRateLimitedError);
    expect(r.saves).toEqual([]);
  });

  it("stores the state before a rate limit on a post, so the retry posts again", async () => {
    const r = rig({
      observation: MERGES_DELETED,
      failCheck: async () => {
        throw new GitHubRateLimitedError(403, "secondary rate limit", 60_000);
      },
    });
    await expect(r.read(RULESET_DELETED)).rejects.toBeInstanceOf(GitHubRateLimitedError);
    expect(r.row()).toMatchObject({ health: "drifted", postedDigest: null, notifiedHealth: "healthy" });

    r.script.failCheck = async () => {};
    r.reset();
    const outcome = await r.read();
    expect(outcome).toMatchObject({ posted: 2, notified: true });
    // The retry is a sweep, and it keeps the attribution the event gave.
    expect(outcome?.differences[0]?.changed_by).toBe("octocat");
  });

  it("posts again on the next read when the pull requests could not be listed", async () => {
    const r = rig({
      observation: MERGES_DELETED,
      prs: async () => {
        throw new GitHubApiError(502, "Bad gateway");
      },
    });
    expect((await r.read())?.posted).toBe(0);
    expect(r.row()?.postedDigest).toBeNull();
    r.script.prs = [PR1];
    r.reset();
    expect((await r.read())?.posted).toBe(1);
  });

  it("restores on the next read when the pull requests could not be listed", async () => {
    const r = rig({ observation: MERGES_DELETED });
    await r.read();
    r.script.observation = CLEAN;
    r.script.prs = async () => {
      throw new GitHubApiError(502, "Bad gateway");
    };
    r.reset();
    expect((await r.read())?.restored).toBe(0);
    expect(r.row()?.postedDigest).not.toBeNull();
    r.script.prs = [PR1];
    r.reset();
    expect((await r.read())?.restored).toBe(1);
    expect(r.row()?.postedDigest).toBeNull();
  });

  it("posts on every pull request again when a post on one of them failed", async () => {
    const r = rig({
      observation: MERGES_DELETED,
      failCheck: async (pr) => {
        if (pr.number === 12) throw new GitHubApiError(502, "Bad gateway");
      },
    });
    expect((await r.read(RULESET_DELETED))?.posted).toBe(1);
    // The row records that the report did not reach every pull request.
    expect(r.row()?.postedDigest).not.toBeNull();
    expect(r.row()?.postedDigest).not.toMatch(/^[0-9a-f]{64}$/);

    r.script.failCheck = async () => {};
    r.reset();
    expect((await r.read())?.posted).toBe(2);
    expect(r.host.failCheck.mock.calls.map(([pr]) => pr.number)).toEqual([11, 12]);
    expect(r.row()?.postedDigest).toMatch(/^[0-9a-f]{64}$/);

    // Once the report reached every pull request, an unchanged sweep posts nothing.
    r.reset();
    expect((await r.read())?.posted).toBe(0);
    expect(r.host.failCheck).not.toHaveBeenCalled();
  });

  it("restores again on the next read when a restore on one pull request failed", async () => {
    const r = rig({ observation: MERGES_DELETED });
    await r.read(RULESET_DELETED);
    r.script.observation = CLEAN;
    r.reset();
    r.host.restoreCheck.mockImplementation(async (pr) => {
      if (pr.number === 12) throw new GitHubApiError(502, "Bad gateway");
    });
    expect(await r.read()).toMatchObject({ health: "healthy", previous: "drifted", restored: 1 });
    expect(r.row()?.postedDigest).not.toBeNull();

    r.host.restoreCheck.mockImplementation(async () => {});
    r.reset();
    expect(await r.read()).toMatchObject({ health: "healthy", restored: 2, notified: false });
    expect(r.host.restoreCheck.mock.calls.map(([pr]) => pr.number)).toEqual([11, 12]);
    expect(r.row()?.postedDigest).toBeNull();

    // With every check put back, the next healthy read has nothing to restore.
    r.reset();
    await r.read();
    expect(r.host.openPullRequests).not.toHaveBeenCalled();
  });

  it("restores the checks that went out when the first post reached only some pull requests", async () => {
    const r = rig({
      observation: MERGES_DELETED,
      failCheck: async (pr) => {
        if (pr.number === 12) throw new GitHubApiError(502, "Bad gateway");
      },
    });
    expect((await r.read(RULESET_DELETED))?.posted).toBe(1);
    r.script.observation = CLEAN;
    r.reset();
    expect(await r.read()).toMatchObject({ health: "healthy", previous: "drifted", restored: 2 });
    expect(r.host.restoreCheck.mock.calls.map(([pr]) => pr.number)).toEqual([11, 12]);
    expect(r.row()?.postedDigest).toBeNull();
  });

  // #4653: a host can hold more open pull requests than one read lists.
  describe("a cut list of open pull requests", () => {
    it("never records the report as posted everywhere", async () => {
      const r = rig({ observation: MERGES_DELETED, complete: false });
      expect((await r.read(RULESET_DELETED))?.posted).toBe(2);
      expect(r.row()?.postedDigest).not.toBeNull();
      expect(r.row()?.postedDigest).not.toMatch(/^[0-9a-f]{64}$/);

      // So the next sweep posts again instead of skipping an unchanged report.
      r.reset();
      expect((await r.read())?.posted).toBe(2);
    });

    it("keeps the digest set after a recovery that could not reach every pull request", async () => {
      const r = rig({ observation: MERGES_DELETED });
      await r.read(RULESET_DELETED);
      r.script.observation = CLEAN;
      r.script.complete = false;
      r.reset();
      expect((await r.read())?.restored).toBe(2);
      expect(r.row()?.postedDigest).not.toBeNull();
    });

    it("posts on the pull request a webhook named even when the list missed it", async () => {
      const r = rig({ observation: MERGES_DELETED });
      await r.read(RULESET_DELETED);
      r.script.prs = [PR1];
      r.script.complete = false;
      r.reset();
      const outcome = await r.read({
        ...SWEEP_TRIGGER,
        reason: "pull_request.synchronize",
        pull_request: { number: 12, head_sha: PR2.head_sha },
      });
      expect(outcome?.posted).toBe(1);
      expect(r.host.failCheck.mock.calls.map(([pr]) => [pr.number, pr.head_sha])).toEqual([
        [12, PR2.head_sha],
      ]);
    });
  });

  it("retries a failed notification on the next read", async () => {
    const r = rig({ observation: MERGES_DELETED });
    r.notify.mockRejectedValueOnce(new Error("Resend answered 500"));
    const first = await r.read();
    expect(first?.notified).toBe(false);
    expect(r.row()?.notifiedHealth).toBe("healthy");

    const second = await r.read();
    expect(second?.notified).toBe(true);
    expect(r.notify).toHaveBeenCalledTimes(2);
    expect(r.row()?.notifiedHealth).toBe("drifted");
  });

  it("notifies once for each state a repo passes through", async () => {
    const r = rig();
    await r.read();
    r.script.observation = MERGES_DELETED;
    await r.read();
    r.script.observation = UNINSTALLED;
    await r.read();
    r.script.observation = CLEAN;
    await r.read();
    await r.read();
    expect(r.notify.mock.calls.map(([, s]) => s.health)).toEqual([
      "drifted",
      "disconnected",
      "healthy",
    ]);
  });

  it("takes the repository name the host reports now", async () => {
    const r = rig({ observation: { ...CLEAN, repository: "acme/steering-renamed" } });
    await r.read();
    expect(r.row()?.repository).toBe("acme/steering-renamed");
  });
});
