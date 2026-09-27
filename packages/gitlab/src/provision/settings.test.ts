import { describe, expect, it } from "vitest";
import type { GitlabResponse, GitlabRest } from "./http";
import { applyGitlabSettings, compareGitlabSettings, readGitlabSettings } from "./settings";
import { EXAMPLE_GITLAB_BASELINE, FakeGitlab } from "./testing/fake-gitlab";
import type { FakeGitlabSnapshot } from "./testing/fake-gitlab";
import type { ObservedGitlabSettings, SteeringBot, SteeringGitlabSettings } from "./types";

const GROUP = { id: 7, full_path: "acme" };
const BOT: SteeringBot = { symbol: "oxagen-steering", user_id: 99, username: "group_7_bot" };
const BASELINE = EXAMPLE_GITLAB_BASELINE;
const PROJECT = "/projects/1";
const PROTECTIONS = "/projects/1/protected_branches";
const PROTECTION_MAIN = "/projects/1/protected_branches/main";

/** A project with main and GitLab's defaults, as the first commit leaves it. */
async function freshProject(): Promise<FakeGitlab> {
  const fake = new FakeGitlab({ group: GROUP, bot: { user_id: 99, username: BOT.username } });
  fake.seedProject({ name: "oxagen-support", description: "d" });
  await fake.rest().request("POST", "/projects/1/repository/commits", {
    branch: "main",
    commit_message: "Seed",
    actions: [{ action: "create", file_path: "README.md", content: "# Steering\n" }],
  });
  return fake;
}

/** A project where every setting the baseline holds is wrong. */
async function driftedProject(): Promise<FakeGitlab> {
  const fake = await freshProject();
  const rest = fake.rest();
  await rest.request("PUT", PROJECT, {
    visibility: "internal",
    default_branch: "other",
    squash_option: "never",
    only_allow_merge_if_pipeline_succeeds: false,
    remove_source_branch_after_merge: false,
    builds_access_level: "enabled",
  });
  await rest.request("POST", PROTECTIONS, {
    name: "main",
    push_access_level: 40,
    merge_access_level: 40,
    allow_force_push: true,
  });
  return fake;
}

function apply(fake: FakeGitlab, rest: GitlabRest = fake.rest()) {
  return applyGitlabSettings(rest, 1, BOT, BASELINE);
}

async function cleanSnapshot(): Promise<FakeGitlabSnapshot> {
  const fake = await freshProject();
  await apply(fake);
  return fake.snapshot();
}

/** The writes made after the first `skip` writes. */
function writesAfter(fake: FakeGitlab, skip: number): { method: string; path: string }[] {
  return fake.writes().slice(skip);
}

/** A rest helper that records each write before the fake answers it. */
function recording(fake: FakeGitlab): {
  rest: GitlabRest;
  sent: { method: string; path: string; body: unknown }[];
} {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const inner = fake.rest();
  return {
    sent,
    rest: {
      request<T>(method: string, path: string, body?: unknown, accept?: readonly number[]) {
        if (method !== "GET") sent.push({ method, path, body });
        return inner.request<T>(method, path, body, accept);
      },
    },
  };
}

const OBSERVED_BASELINE: ObservedGitlabSettings = {
  visibility: "private",
  default_branch: "main",
  protected_branches: {
    main: { push_access: "no_one", merge_access: "oxagen-steering", allow_force_push: false },
  },
  merge_requests: {
    squash_option: "always",
    only_allow_merge_if_pipeline_succeeds: true,
    remove_source_branch_after_merge: true,
  },
  ci_cd: { builds_access_level: "disabled" },
};

/** A fresh copy of a read that matches the baseline. */
function matching(): ObservedGitlabSettings {
  return JSON.parse(JSON.stringify(OBSERVED_BASELINE)) as ObservedGitlabSettings;
}

describe("applyGitlabSettings", () => {
  it("brings a fresh project to the baseline with nothing remaining", async () => {
    const fake = await freshProject();
    const result = await apply(fake);
    expect(result.changed).toEqual([
      {
        setting: "protected_branches.main",
        expected: BASELINE.protected_branches.main,
        actual: null,
      },
      { setting: "merge_requests.squash_option", expected: "always", actual: "default_off" },
      {
        setting: "merge_requests.only_allow_merge_if_pipeline_succeeds",
        expected: true,
        actual: false,
      },
      { setting: "ci_cd.builds_access_level", expected: "disabled", actual: "enabled" },
    ]);
    expect(result.remaining).toEqual([]);
    expect(result.observed).toEqual(OBSERVED_BASELINE);
    expect(writesAfter(fake, 1)).toEqual([
      { method: "PUT", path: PROJECT },
      { method: "POST", path: PROTECTIONS },
    ]);
  });

  it("sends only the fields that differ and protects main for the bot alone", async () => {
    const fake = await freshProject();
    const { rest, sent } = recording(fake);
    await apply(fake, rest);
    expect(sent).toEqual([
      {
        method: "PUT",
        path: PROJECT,
        body: {
          squash_option: "always",
          only_allow_merge_if_pipeline_succeeds: true,
          builds_access_level: "disabled",
        },
      },
      {
        method: "POST",
        path: PROTECTIONS,
        body: {
          name: "main",
          push_access_level: 0,
          merge_access_level: 0,
          allowed_to_merge: [{ user_id: 99 }],
          allow_force_push: false,
        },
      },
    ]);
  });

  it("changes nothing on a second apply", async () => {
    const fake = await freshProject();
    await apply(fake);
    const writes = fake.writes().length;
    const second = await apply(fake);
    expect(second).toEqual({ changed: [], remaining: [], observed: OBSERVED_BASELINE });
    expect(fake.writes()).toHaveLength(writes);
  });

  it("fixes every setting when all of them are wrong", async () => {
    const fake = await driftedProject();
    const setup = fake.writes().length;
    const result = await apply(fake);
    expect(result.changed.map((d) => d.setting)).toEqual([
      "visibility",
      "default_branch",
      "protected_branches.main.push_access",
      "protected_branches.main.merge_access",
      "protected_branches.main.allow_force_push",
      "merge_requests.squash_option",
      "merge_requests.only_allow_merge_if_pipeline_succeeds",
      "merge_requests.remove_source_branch_after_merge",
      "ci_cd.builds_access_level",
    ]);
    expect(result.changed[2]).toEqual({
      setting: "protected_branches.main.push_access",
      expected: "no_one",
      actual: "maintainers",
    });
    expect(result.remaining).toEqual([]);
    expect(writesAfter(fake, setup)).toEqual([
      { method: "PUT", path: PROJECT },
      { method: "DELETE", path: PROTECTION_MAIN },
      { method: "POST", path: PROTECTIONS },
    ]);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("replaces only the protection when only the protection differs", async () => {
    const fake = await freshProject();
    await apply(fake);
    const rest = fake.rest();
    await rest.request("DELETE", PROTECTION_MAIN);
    await rest.request("POST", PROTECTIONS, {
      name: "main",
      push_access_level: 0,
      merge_access_level: 0,
      allowed_to_merge: [{ user_id: 99 }],
      allow_force_push: true,
    });
    const setup = fake.writes().length;
    const result = await apply(fake);
    expect(result.changed).toEqual([
      { setting: "protected_branches.main.allow_force_push", expected: false, actual: true },
    ]);
    expect(writesAfter(fake, setup)).toEqual([
      { method: "DELETE", path: PROTECTION_MAIN },
      { method: "POST", path: PROTECTIONS },
    ]);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("returns what a second read still finds different", async () => {
    const fake = await freshProject();
    const inner = fake.rest();
    // GitLab Free ignores `allowed_to_merge`, so the bot never becomes a merger.
    const free: GitlabRest = {
      request<T>(method: string, path: string, body?: unknown, accept?: readonly number[]) {
        if (method === "POST" && path === PROTECTIONS) {
          const { allowed_to_merge: _ignored, ...rest } = body as Record<string, unknown>;
          return inner.request<T>(method, path, rest, accept);
        }
        return inner.request<T>(method, path, body, accept);
      },
    };
    const result = await apply(fake, free);
    expect(result.remaining).toEqual([
      {
        setting: "protected_branches.main.merge_access",
        expected: "oxagen-steering",
        actual: "no_one",
      },
    ]);
    expect(result.observed.protected_branches.main?.merge_access).toBe("no_one");
  });

  it("throws before any request when the baseline names a merger it cannot resolve", async () => {
    const fake = await freshProject();
    const calls = fake.calls.length;
    const baseline: SteeringGitlabSettings = {
      ...BASELINE,
      protected_branches: {
        main: { push_access: "no_one", merge_access: "someone", allow_force_push: false },
      },
    };
    await expect(applyGitlabSettings(fake.rest(), 1, BOT, baseline)).rejects.toThrow(
      "The baseline names someone, which provisioning cannot resolve to a GitLab user.",
    );
    expect(fake.calls).toHaveLength(calls);
  });

  it("accepts a protection that vanished before its delete and protects main again", async () => {
    const fake = await driftedProject();
    fake.failNext({ method: "DELETE", path: PROTECTION_MAIN, status: 404, after: true });
    const result = await apply(fake);
    expect(result.remaining).toEqual([]);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });
});

describe("applyGitlabSettings after a failure", () => {
  interface WriteCase {
    scenario: string;
    setup: () => Promise<FakeGitlab>;
    method: string;
    path: string;
  }
  const cases: WriteCase[] = [
    { scenario: "a fresh project", setup: freshProject, method: "PUT", path: PROJECT },
    { scenario: "a fresh project", setup: freshProject, method: "POST", path: PROTECTIONS },
    { scenario: "a drifted project", setup: driftedProject, method: "PUT", path: PROJECT },
    { scenario: "a drifted project", setup: driftedProject, method: "DELETE", path: PROTECTION_MAIN },
    { scenario: "a drifted project", setup: driftedProject, method: "POST", path: PROTECTIONS },
  ];

  async function failThenRerun(c: WriteCase, after: boolean): Promise<void> {
    const fake = await c.setup();
    const status = after ? 502 : 500;
    fake.failNext({ method: c.method, path: c.path, status, after });
    await expect(apply(fake)).rejects.toMatchObject({ status });
    const rerun = await apply(fake);
    expect(rerun.remaining).toEqual([]);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  }

  it.each(cases)(
    "reaches the clean state on $scenario after $method $path fails before GitLab applies it",
    (c) => failThenRerun(c, false),
  );

  it.each(cases)(
    "reaches the clean state on $scenario after the answer to $method $path is lost",
    (c) => failThenRerun(c, true),
  );

  it("writes nothing on a rerun after the last write's answer was lost", async () => {
    const fake = await driftedProject();
    fake.failNext({ method: "POST", path: PROTECTIONS, status: 502, after: true });
    await expect(apply(fake)).rejects.toMatchObject({ status: 502 });
    const writes = fake.writes().length;
    const rerun = await apply(fake);
    expect(rerun.changed).toEqual([]);
    expect(fake.writes()).toHaveLength(writes);
  });

  it("protects main again on a rerun after the delete went through and the create did not", async () => {
    const fake = await driftedProject();
    fake.failNext({ method: "POST", path: PROTECTIONS, status: 500 });
    await expect(apply(fake)).rejects.toMatchObject({ status: 500 });
    expect(fake.snapshot().projects["acme/oxagen-support"]?.protected_branches).toEqual({});
    const writes = fake.writes().length;
    const rerun = await apply(fake);
    expect(rerun.changed).toEqual([
      { setting: "protected_branches.main", expected: BASELINE.protected_branches.main, actual: null },
    ]);
    expect(writesAfter(fake, writes)).toEqual([{ method: "POST", path: PROTECTIONS }]);
  });
});

describe("readGitlabSettings", () => {
  /** A rest helper that answers the two reads with fixed bodies. */
  function reading(project: unknown, branches: unknown): GitlabRest {
    return {
      request<T>(_method: string, path: string): Promise<GitlabResponse<T>> {
        const data = path.includes("/protected_branches") ? branches : project;
        return Promise.resolve({ status: 200, data: data as T, message: null });
      },
    };
  }

  it("reads every kind of access entry as a symbol", async () => {
    const rest = reading(
      {
        visibility: "private",
        default_branch: null,
        squash_option: "never",
        only_allow_merge_if_pipeline_succeeds: null,
        remove_source_branch_after_merge: null,
        builds_access_level: "private",
      },
      [
        {
          name: "main",
          push_access_levels: [
            { access_level: 60 },
            { access_level: 30 },
            { access_level: 40, user_id: 99 },
            { access_level: 40, user_id: 5 },
            { access_level: 40, group_id: 3 },
            { access_level: 40, deploy_key_id: 4 },
            { access_level: 50 },
            { access_level: 0 },
          ],
        },
        {
          name: "release/*",
          push_access_levels: [
            { access_level: 40, user_id: null, group_id: null, deploy_key_id: null },
            { access_level: 40 },
          ],
          merge_access_levels: [{ access_level: 0 }],
          allow_force_push: true,
        },
      ],
    );
    expect(await readGitlabSettings(rest, 5, BOT)).toEqual({
      visibility: "private",
      default_branch: null,
      protected_branches: {
        main: {
          push_access: "admins, deploy_key:4, developers, group:3, level:50, oxagen-steering, user:5",
          merge_access: "no_one",
          allow_force_push: false,
        },
        "release/*": { push_access: "maintainers", merge_access: "no_one", allow_force_push: true },
      },
      merge_requests: {
        squash_option: "never",
        only_allow_merge_if_pipeline_succeeds: false,
        remove_source_branch_after_merge: false,
      },
      ci_cd: { builds_access_level: "private" },
    });
  });

  it("reads the level entry GitLab keeps beside the bot as nothing extra", async () => {
    const fake = await freshProject();
    await apply(fake);
    const observed = await readGitlabSettings(fake.rest(), 1, BOT);
    expect(observed.protected_branches.main).toEqual({
      push_access: "no_one",
      merge_access: "oxagen-steering",
      allow_force_push: false,
    });
    expect(fake.calls.slice(-2)).toEqual([
      { method: "GET", path: PROJECT },
      { method: "GET", path: `${PROTECTIONS}?per_page=100` },
    ]);
  });
});

describe("compareGitlabSettings", () => {
  it("finds nothing when the read matches the baseline", () => {
    expect(compareGitlabSettings(BASELINE, matching(), BOT)).toEqual([]);
  });

  it.each<[string, (o: ObservedGitlabSettings) => void, string, unknown, unknown]>([
    ["visibility", (o) => (o.visibility = "public"), "visibility", "private", "public"],
    ["default branch", (o) => (o.default_branch = null), "default_branch", "main", null],
    [
      "push access",
      (o) => {
        if (o.protected_branches.main) o.protected_branches.main.push_access = "developers";
      },
      "protected_branches.main.push_access",
      "no_one",
      "developers",
    ],
    [
      "merge access",
      (o) => {
        if (o.protected_branches.main)
          o.protected_branches.main.merge_access = "maintainers, user:99";
      },
      "protected_branches.main.merge_access",
      "oxagen-steering",
      "maintainers, oxagen-steering",
    ],
    [
      "force push",
      (o) => {
        if (o.protected_branches.main) o.protected_branches.main.allow_force_push = true;
      },
      "protected_branches.main.allow_force_push",
      false,
      true,
    ],
    [
      "squash option",
      (o) => (o.merge_requests.squash_option = "default_on"),
      "merge_requests.squash_option",
      "always",
      "default_on",
    ],
    [
      "pipeline rule",
      (o) => (o.merge_requests.only_allow_merge_if_pipeline_succeeds = false),
      "merge_requests.only_allow_merge_if_pipeline_succeeds",
      true,
      false,
    ],
    [
      "source branch removal",
      (o) => (o.merge_requests.remove_source_branch_after_merge = false),
      "merge_requests.remove_source_branch_after_merge",
      true,
      false,
    ],
    [
      "CI/CD access",
      (o) => (o.ci_cd.builds_access_level = "enabled"),
      "ci_cd.builds_access_level",
      "disabled",
      "enabled",
    ],
  ])("reports a different %s", (_label, change, setting, expected, actual) => {
    const observed = matching();
    change(observed);
    expect(compareGitlabSettings(BASELINE, observed, BOT)).toEqual([
      { setting, expected, actual },
    ]);
  });

  it("reports a missing protection as one difference", () => {
    const observed = matching();
    delete observed.protected_branches.main;
    expect(compareGitlabSettings(BASELINE, observed, BOT)).toEqual([
      { setting: "protected_branches.main", expected: BASELINE.protected_branches.main, actual: null },
    ]);
  });

  it("reads the bot's user entry as the bot", () => {
    const observed = matching();
    if (observed.protected_branches.main)
      observed.protected_branches.main.merge_access = `user:${BOT.user_id}`;
    expect(compareGitlabSettings(BASELINE, observed, BOT)).toEqual([]);
  });

  it("leaves alone a protected branch the baseline does not name", () => {
    const observed = matching();
    observed.protected_branches["release/*"] = {
      push_access: "maintainers",
      merge_access: "maintainers",
      allow_force_push: true,
    };
    expect(compareGitlabSettings(BASELINE, observed, BOT)).toEqual([]);
  });

  it("ignores the required status, which GitLab does not store per project", () => {
    const baseline: SteeringGitlabSettings = {
      ...BASELINE,
      merge_requests: { ...BASELINE.merge_requests, required_status: "Something else" },
    };
    expect(compareGitlabSettings(baseline, matching(), BOT)).toEqual([]);
  });
});
