import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../fetch-client";
import { recordDeployment } from "./deployment";
import { writeFirstCommit } from "./first-commit";
import { createGithubRest, type GithubResponse, type GithubRest, type HttpFetch } from "./http";
import {
  applySettings,
  compareSettings,
  readSettings,
  rulesetBody,
  rulesetKey,
} from "./settings";
import { EXAMPLE_GITHUB_BASELINE, FakeGithub } from "./testing/fake-github";
import type {
  ObservedGithubSettings,
  ObservedRuleset,
  RepoAddress,
  SteeringApp,
  SteeringGithubSettings,
} from "./types";

const APP: SteeringApp = { symbol: "oxagen-steering", id: 4242, slug: "oxagen-steering" };
const REPO: RepoAddress = { owner: "acme", name: "oxagen-support" };
const ROOT = "/repos/acme/oxagen-support";
const BASELINE: SteeringGithubSettings = EXAMPLE_GITHUB_BASELINE;
const ENVIRONMENTS = Object.keys(BASELINE.environments);
const FREE_BASELINE: SteeringGithubSettings = {
  ...BASELINE,
  rulesets: {},
  environments: {},
};

/** A fake whose steering repo holds its first commit and no settings yet. */
async function provisioned(orgDefaultBranch = "main"): Promise<FakeGithub> {
  const fake = new FakeGithub({ org: "acme", app: APP, org_default_branch: orgDefaultBranch });
  fake.seedRepository({ name: REPO.name, in_installation: true });
  await writeFirstCommit(fake.appRest(), {
    repo: REPO,
    files: [{ path: "README.md", content: "# Support steering\n" }],
    message: "Oxagen steering v1",
    initial_branch: orgDefaultBranch,
  });
  return fake;
}

function writesSince(fake: FakeGithub, from: number): { method: string; path: string }[] {
  return fake.calls.slice(from).filter((c) => c.method !== "GET");
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`The test setup has no ${what}.`);
  return value;
}

/** What a read of a repository that matches the baseline returns. */
function observed(): ObservedGithubSettings {
  const rulesets: Record<string, ObservedRuleset> = {};
  let id = 1;
  for (const [key, r] of Object.entries(BASELINE.rulesets)) {
    rulesets[key] = {
      id: id++,
      name: r.name,
      target: r.target,
      enforcement: r.enforcement,
      include: [...r.include],
      bypass_actors: r.bypass_actors.map((a) => ({ ...a })),
      rules: JSON.parse(JSON.stringify(r.rules)) as ObservedRuleset["rules"],
    };
  }
  const environments: ObservedGithubSettings["environments"] = {};
  for (const [name, env] of Object.entries(BASELINE.environments))
    environments[name] = {
      deployment_branches: [...env.deployment_branches],
      deployed_by: env.deployed_by,
    };
  return {
    visibility: BASELINE.visibility,
    default_branch: BASELINE.default_branch,
    rulesets,
    merge: { ...BASELINE.merge },
    actions: { ...BASELINE.actions },
    environments,
  };
}

function rule(o: ObservedGithubSettings, key: string, type: string) {
  const ruleset = need(o.rulesets[key], `ruleset ${key}`);
  return need(
    ruleset.rules.find((r) => r.type === type),
    `rule ${type} in ${key}`,
  );
}

/** A client whose nth write answers 502, before or after the fake applies it. */
function failingWrite(fake: FakeGithub, n: number, when: "before" | "after"): GithubRest {
  let seen = 0;
  const fetch: HttpFetch = async (url, init) => {
    if (init.method === "GET") return fake.fetch(url, init);
    seen += 1;
    if (seen !== n) return fake.fetch(url, init);
    if (when === "after") await fake.fetch(url, init);
    return { status: 502, text: () => Promise.resolve('{"message":"injected failure"}') };
  };
  return createGithubRest({ token: "app-token", fetch });
}

/** Reject paid settings endpoints as GitHub does for private Free repositories. */
function freePlanClient(fake: FakeGithub) {
  const paidCalls: string[] = [];
  const fetch: HttpFetch = (url, init) => {
    if (/\/(rulesets|environments|branches)\b/.test(url)) {
      paidCalls.push(`${init.method} ${url}`);
      return Promise.resolve({
        status: 403,
        text: () => Promise.resolve('{"message":"Upgrade your GitHub plan"}'),
      });
    }
    return fake.fetch(url, init);
  };
  return { rest: createGithubRest({ token: "app-token", fetch }), paidCalls };
}

/** A client that returns the given answers in order, for shapes the fake never sends. */
function scripted(...answers: GithubResponse<unknown>[]): GithubRest {
  const queue = [...answers];
  return {
    request<T>(): Promise<GithubResponse<T>> {
      const next = queue.shift();
      if (next === undefined) throw new Error("The scripted client ran out of answers.");
      return Promise.resolve(next as GithubResponse<T>);
    },
  };
}

async function headOf(fake: FakeGithub, branch: string): Promise<string> {
  const ref = await fake
    .appRest()
    .request<{ object: { sha: string } }>("GET", `${ROOT}/git/ref/heads/${branch}`);
  return need(ref.data?.object.sha, `branch ${branch}`);
}

async function cleanApply() {
  const fake = await provisioned();
  const from = fake.calls.length;
  const result = await applySettings(fake.appRest(), REPO, APP, BASELINE);
  return { result, writes: writesSince(fake, from), snapshot: fake.snapshot() };
}

describe("rulesetKey", () => {
  it("turns a ruleset name into its snake_case key", () => {
    expect(rulesetKey("Oxagen steering")).toBe("oxagen_steering");
    expect(rulesetKey("  Oxagen: Merges!! ")).toBe("oxagen_merges");
    expect(rulesetKey("__Main--only__")).toBe("main_only");
  });
});

describe("rulesetBody", () => {
  it("names the app by its id where GitHub wants an id", () => {
    const body = rulesetBody(APP, need(BASELINE.rulesets.oxagen_steering, "steering"));
    expect(body).toMatchObject({
      name: "Oxagen steering",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    });
    const rules = (body as { rules: { type: string; parameters?: Record<string, unknown> }[] }).rules;
    expect(rules.find((r) => r.type === "required_status_checks")?.parameters).toEqual({
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: "Oxagen steering", integration_id: 4242 }],
    });
    expect(rules.map((r) => r.type)).toEqual([
      "pull_request",
      "required_status_checks",
      "non_fast_forward",
      "deletion",
      "required_linear_history",
    ]);
  });

  it("names a bypass actor by the app's id", () => {
    const body = rulesetBody(APP, need(BASELINE.rulesets.oxagen_merges, "merges"));
    expect(body).toMatchObject({
      bypass_actors: [{ actor_id: 4242, actor_type: "Integration", bypass_mode: "always" }],
    });
  });

  it("throws for a symbol that is not the steering app", () => {
    const merges = need(BASELINE.rulesets.oxagen_merges, "merges");
    expect(() =>
      rulesetBody(APP, {
        ...merges,
        bypass_actors: [{ actor: "someone-else", bypass_mode: "always" }],
      }),
    ).toThrow("The baseline names someone-else, which provisioning cannot resolve to a GitHub App.");
  });
});

describe("compareSettings", () => {
  it("ignores existing rulesets and environments with the Free baseline", () => {
    expect(compareSettings(FREE_BASELINE, observed(), { require_deployment: true })).toEqual([]);
  });

  it("finds nothing when the repository matches", () => {
    expect(compareSettings(BASELINE, observed())).toEqual([]);
  });

  it("reports the visibility", () => {
    const o = observed();
    o.visibility = "public";
    expect(compareSettings(BASELINE, o)).toEqual([
      { setting: "visibility", expected: "private", actual: "public" },
    ]);
  });

  it("reports the default branch", () => {
    const o = observed();
    o.default_branch = "master";
    expect(compareSettings(BASELINE, o)).toEqual([
      { setting: "default_branch", expected: "main", actual: "master" },
    ]);
  });

  it("reports each merge flag", () => {
    const o = observed();
    o.merge.allow_rebase_merge = true;
    o.merge.delete_branch_on_merge = false;
    expect(compareSettings(BASELINE, o)).toEqual([
      { setting: "merge.allow_rebase_merge", expected: false, actual: true },
      { setting: "merge.delete_branch_on_merge", expected: true, actual: false },
    ]);
  });

  it("reports Actions", () => {
    const o = observed();
    o.actions.enabled = true;
    expect(compareSettings(BASELINE, o)).toEqual([
      { setting: "actions.enabled", expected: false, actual: true },
    ]);
  });

  it("reports a missing ruleset by its name", () => {
    const o = observed();
    delete o.rulesets.oxagen_merges;
    expect(compareSettings(BASELINE, o)).toEqual([
      { setting: "rulesets.oxagen_merges", expected: "Oxagen merges", actual: "missing" },
    ]);
  });

  it("reports a wrong bypass actor", () => {
    const o = observed();
    need(o.rulesets.oxagen_merges, "merges").bypass_actors = [
      { actor: "Integration:999", bypass_mode: "always" },
    ];
    expect(compareSettings(BASELINE, o)).toEqual([
      {
        setting: "rulesets.oxagen_merges.bypass_actors",
        expected: [{ actor: "oxagen-steering", bypass_mode: "always" }],
        actual: [{ actor: "Integration:999", bypass_mode: "always" }],
      },
    ]);
  });

  it("reports a status check bound to the wrong integration", () => {
    const o = observed();
    const checks = rule(o, "oxagen_steering", "required_status_checks");
    checks.parameters = {
      ...checks.parameters,
      required_status_checks: [{ context: "Oxagen steering", integration: "app:999" }],
    };
    expect(compareSettings(BASELINE, o)).toEqual([
      {
        setting: "rulesets.oxagen_steering.rules.required_status_checks.required_status_checks",
        expected: [{ context: "Oxagen steering", integration: "oxagen-steering" }],
        actual: [{ context: "Oxagen steering", integration: "app:999" }],
      },
    ]);
  });

  it("reports the target, the enforcement, and the branches a ruleset covers", () => {
    const o = observed();
    const steering = need(o.rulesets.oxagen_steering, "steering");
    steering.target = "tag";
    steering.enforcement = "evaluate";
    steering.include = ["~DEFAULT_BRANCH"];
    expect(compareSettings(BASELINE, o).map((d) => d.setting)).toEqual([
      "rulesets.oxagen_steering.target",
      "rulesets.oxagen_steering.enforcement",
      "rulesets.oxagen_steering.include",
    ]);
  });

  it("reports a missing rule and a rule the baseline does not name", () => {
    const o = observed();
    const steering = need(o.rulesets.oxagen_steering, "steering");
    steering.rules = steering.rules.filter((r) => r.type !== "deletion");
    steering.rules.push({ type: "creation" });
    expect(compareSettings(BASELINE, o)).toEqual([
      { setting: "rulesets.oxagen_steering.rules.deletion", expected: "present", actual: "missing" },
      { setting: "rulesets.oxagen_steering.rules.creation", expected: "absent", actual: "present" },
    ]);
  });

  it("reports a changed rule parameter and a missing one", () => {
    const o = observed();
    const pr = rule(o, "oxagen_steering", "pull_request");
    const kept = Object.entries(pr.parameters ?? {}).filter(
      ([name]) => name !== "required_review_thread_resolution",
    );
    pr.parameters = { ...Object.fromEntries(kept), required_approving_review_count: 1 };
    expect(compareSettings(BASELINE, o)).toEqual([
      {
        setting: "rulesets.oxagen_steering.rules.pull_request.required_approving_review_count",
        expected: 0,
        actual: 1,
      },
      {
        setting: "rulesets.oxagen_steering.rules.pull_request.required_review_thread_resolution",
        expected: false,
        actual: null,
      },
    ]);
  });

  it("reports every parameter of a rule that came back without parameters", () => {
    const o = observed();
    delete rule(o, "oxagen_merges", "update").parameters;
    expect(compareSettings(BASELINE, o)).toEqual([
      {
        setting: "rulesets.oxagen_merges.rules.update.update_allows_fetch_and_merge",
        expected: false,
        actual: null,
      },
    ]);
  });

  it("compares a list parameter as a set", () => {
    const o = observed();
    const pr = rule(o, "oxagen_steering", "pull_request");
    pr.parameters = { ...pr.parameters, allowed_merge_methods: ["squash"] };
    expect(compareSettings(BASELINE, o)).toEqual([]);
    pr.parameters = { ...pr.parameters, allowed_merge_methods: ["squash", "merge"] };
    expect(compareSettings(BASELINE, o).map((d) => d.setting)).toEqual([
      "rulesets.oxagen_steering.rules.pull_request.allowed_merge_methods",
    ]);
  });

  it("leaves alone a ruleset the baseline does not name", () => {
    const o = observed();
    o.rulesets.customer_rules = {
      id: 99,
      name: "Customer rules",
      target: "branch",
      enforcement: "active",
      include: ["refs/heads/dev"],
      bypass_actors: [],
      rules: [{ type: "deletion" }],
    };
    expect(compareSettings(BASELINE, o)).toEqual([]);
  });

  it("reports a missing environment", () => {
    const o = observed();
    delete o.environments.steering;
    expect(compareSettings(BASELINE, o)).toEqual([
      { setting: "environments.steering", expected: "present", actual: "missing" },
    ]);
  });

  it("reports the branches an environment accepts", () => {
    const o = observed();
    need(o.environments.steering, "steering").deployment_branches = ["*"];
    expect(compareSettings(BASELINE, o)).toEqual([
      {
        setting: "environments.steering.deployment_branches",
        expected: ["main"],
        actual: ["*"],
      },
    ]);
  });

  it("skips the deployer before the first deployment unless require_deployment is set", () => {
    const o = observed();
    need(o.environments.steering, "steering").deployed_by = null;
    expect(compareSettings(BASELINE, o)).toEqual([]);
    expect(compareSettings(BASELINE, o, { require_deployment: false })).toEqual([]);
    expect(compareSettings(BASELINE, o, { require_deployment: true })).toEqual([
      { setting: "environments.steering.deployed_by", expected: "oxagen-steering", actual: null },
    ]);
  });

  it("reports a deployment someone else recorded", () => {
    const o = observed();
    need(o.environments.steering, "steering").deployed_by = "fake-owner";
    expect(compareSettings(BASELINE, o)).toEqual([
      { setting: "environments.steering.deployed_by", expected: "oxagen-steering", actual: "fake-owner" },
    ]);
  });
});

describe("readSettings", () => {
  it("reads a repository GitHub just created", async () => {
    const fake = await provisioned();
    const read = await readSettings(fake.appRest(), REPO, APP, ENVIRONMENTS);
    expect(read).toEqual({
      visibility: "private",
      default_branch: "main",
      rulesets: {},
      merge: {
        allow_squash_merge: true,
        allow_merge_commit: true,
        allow_rebase_merge: true,
        delete_branch_on_merge: false,
      },
      actions: { enabled: true },
      environments: {},
    });
  });

  it("skips paid endpoints when rulesets and environments are unmanaged", async () => {
    const fake = await provisioned();
    const { rest, paidCalls } = freePlanClient(fake);

    const read = await readSettings(rest, REPO, APP, [], false);

    expect(read.rulesets).toEqual({});
    expect(read.environments).toEqual({});
    expect(read.visibility).toBe("private");
    expect(paidCalls).toEqual([]);
  });

  it("propagates a ruleset permission failure when rulesets are requested", async () => {
    const fake = await provisioned();
    const { rest } = freePlanClient(fake);

    await expect(readSettings(rest, REPO, APP, [])).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("reads rulesets back in the baseline's terms", async () => {
    const fake = await provisioned();
    await applySettings(fake.appRest(), REPO, APP, BASELINE);
    const read = await readSettings(fake.appRest(), REPO, APP, ENVIRONMENTS);
    expect(read.rulesets.oxagen_merges).toMatchObject({
      name: "Oxagen merges",
      bypass_actors: [{ actor: "oxagen-steering", bypass_mode: "always" }],
    });
    expect(rule(read, "oxagen_steering", "required_status_checks").parameters).toEqual({
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: "Oxagen steering", integration: "oxagen-steering" }],
    });
  });

  it("names actors and integrations that are not the steering app", async () => {
    const fake = await provisioned();
    const rest = fake.appRest();
    await rest.request("POST", `${ROOT}/rulesets`, {
      name: "Customer rules",
      target: "branch",
      enforcement: "active",
      bypass_actors: [
        { actor_id: 5, actor_type: "Team", bypass_mode: "pull_request" },
        { actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always" },
      ],
      conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "ci" }, { context: "lint", integration_id: 999 }],
          },
        },
        { type: "deletion" },
      ],
    });
    const read = await readSettings(rest, REPO, APP, []);
    expect(read.rulesets.customer_rules).toEqual({
      id: expect.any(Number),
      name: "Customer rules",
      target: "branch",
      enforcement: "active",
      include: ["refs/heads/dev"],
      bypass_actors: [
        { actor: "Team:5", bypass_mode: "pull_request" },
        { actor: "OrganizationAdmin:none", bypass_mode: "always" },
      ],
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "ci", integration: "any" },
              { context: "lint", integration: "app:999" },
            ],
          },
        },
        { type: "deletion" },
      ],
    });
  });

  it("fills defaults for a ruleset that names only itself", async () => {
    const fake = await provisioned();
    const rest = fake.appRest();
    await rest.request("POST", `${ROOT}/rulesets`, { name: "Bare" });
    await rest.request("POST", `${ROOT}/rulesets`, {
      name: "Odd checks",
      conditions: null,
      rules: [
        { type: "required_status_checks" },
        { type: "required_status_checks", parameters: { required_status_checks: "all" } },
      ],
    });
    const read = await readSettings(rest, REPO, APP, []);
    expect(read.rulesets.bare).toEqual({
      id: expect.any(Number),
      name: "Bare",
      target: "branch",
      enforcement: "disabled",
      include: [],
      bypass_actors: [],
      rules: [],
    });
    expect(read.rulesets.odd_checks?.rules).toEqual([
      { type: "required_status_checks" },
      { type: "required_status_checks", parameters: { required_status_checks: "all" } },
    ]);
  });

  it("skips a ruleset that disappears between the list and the read", async () => {
    const fake = await provisioned();
    await applySettings(fake.appRest(), REPO, APP, BASELINE);
    fake.failNext({ method: "GET", path: /\/rulesets\/\d+$/, status: 404 });
    const read = await readSettings(fake.appRest(), REPO, APP, ENVIRONMENTS);
    expect(Object.keys(read.rulesets)).toEqual(["oxagen_merges"]);
  });

  it("reads an environment that accepts every branch or only protected ones", async () => {
    const fake = await provisioned();
    const rest = fake.appRest();
    await rest.request("PUT", `${ROOT}/environments/open`, { deployment_branch_policy: null });
    await rest.request("PUT", `${ROOT}/environments/guarded`, {
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    });
    const read = await readSettings(rest, REPO, APP, ["open", "guarded", "absent"]);
    expect(read.environments).toEqual({
      open: { deployment_branches: ["*"], deployed_by: null },
      guarded: { deployment_branches: ["<protected branches>"], deployed_by: null },
    });
  });

  it("names who recorded the latest deployment", async () => {
    const fake = await provisioned();
    await applySettings(fake.appRest(), REPO, APP, BASELINE);
    const deploy = (rest: GithubRest) =>
      rest.request("POST", `${ROOT}/deployments`, { ref: "main", environment: "steering" });

    await deploy(fake.appRest());
    const byApp = await readSettings(fake.appRest(), REPO, APP, ENVIRONMENTS);
    expect(byApp.environments.steering?.deployed_by).toBe("oxagen-steering");

    // Read with another app's identity, the steering app shows as its slug.
    const other: SteeringApp = { symbol: "other", id: 1, slug: "other-app" };
    const byOther = await readSettings(fake.appRest(), REPO, other, ENVIRONMENTS);
    expect(byOther.environments.steering?.deployed_by).toBe("oxagen-steering");

    await deploy(fake.userRest());
    const byUser = await readSettings(fake.appRest(), REPO, APP, ENVIRONMENTS);
    expect(byUser.environments.steering?.deployed_by).toBe("fake-owner");
  });

  it("fills GitHub's defaults for fields an answer leaves out", async () => {
    const privateRepo = scripted(
      { status: 200, data: { default_branch: "main", private: true }, message: null },
      { status: 200, data: null, message: null },
      { status: 200, data: null, message: null },
    );
    expect(await readSettings(privateRepo, REPO, APP, [])).toEqual({
      visibility: "private",
      default_branch: "main",
      rulesets: {},
      merge: {
        allow_squash_merge: true,
        allow_merge_commit: true,
        allow_rebase_merge: true,
        delete_branch_on_merge: false,
      },
      actions: { enabled: true },
      environments: {},
    });

    const publicRepo = scripted(
      { status: 200, data: { default_branch: "main", private: false }, message: null },
      { status: 200, data: { enabled: false }, message: null },
      { status: 200, data: [], message: null },
    );
    const read = await readSettings(publicRepo, REPO, APP, []);
    expect(read.visibility).toBe("public");
    expect(read.actions.enabled).toBe(false);
  });

  it("reads an environment whose policy list and deployment list come back empty", async () => {
    const rest = scripted(
      { status: 200, data: { visibility: "private", default_branch: "main" }, message: null },
      { status: 200, data: { enabled: false }, message: null },
      {
        status: 200,
        data: { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
        message: null,
      },
      { status: 200, data: null, message: null },
      { status: 200, data: null, message: null },
      { status: 200, data: [], message: null },
    );
    const read = await readSettings(rest, REPO, APP, ["steering"]);
    expect(read.environments).toEqual({ steering: { deployment_branches: [], deployed_by: null } });
  });

  it("names the deployer unknown when a deployment carries no creator", async () => {
    const rest = scripted(
      { status: 200, data: { visibility: "private", default_branch: "main" }, message: null },
      { status: 200, data: { enabled: false }, message: null },
      { status: 200, data: { deployment_branch_policy: null }, message: null },
      {
        status: 200,
        data: [{ creator: null, performed_via_github_app: null }],
        message: null,
      },
      { status: 200, data: [], message: null },
    );
    const read = await readSettings(rest, REPO, APP, ["steering"]);
    expect(read.environments).toEqual({
      steering: { deployment_branches: ["*"], deployed_by: "unknown" },
    });
  });

  it("throws when GitHub returns no repository", async () => {
    const rest = scripted({ status: 200, data: null, message: null });
    await expect(readSettings(rest, REPO, APP, [])).rejects.toThrow("GitHub returned no repository");
  });
});

describe("applySettings", () => {
  it("brings a new repository to the baseline", async () => {
    const { result, writes, snapshot } = await cleanApply();

    expect(result.remaining).toEqual([]);
    expect(result.changed.map((d) => d.setting)).toEqual([
      "merge.allow_merge_commit",
      "merge.allow_rebase_merge",
      "merge.delete_branch_on_merge",
      "actions.enabled",
      "rulesets.oxagen_steering",
      "rulesets.oxagen_merges",
      "environments.steering",
    ]);
    expect(writes).toEqual([
      { method: "PATCH", path: ROOT },
      { method: "PUT", path: `${ROOT}/actions/permissions` },
      { method: "POST", path: `${ROOT}/rulesets` },
      { method: "POST", path: `${ROOT}/rulesets` },
      { method: "PUT", path: `${ROOT}/environments/steering` },
      { method: "POST", path: `${ROOT}/environments/steering/deployment-branch-policies` },
    ]);
    expect(snapshot).toMatchObject({
      repositories: {
        [REPO.name]: {
          private: true,
          default_branch: "main",
          merge: BASELINE.merge,
          actions_enabled: false,
          environments: {
            steering: {
              deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
              branch_policies: ["branch:main"],
            },
          },
        },
      },
    });
    expect(compareSettings(BASELINE, result.observed)).toEqual([]);
  });

  it("changes nothing on a second apply", async () => {
    const fake = await provisioned();
    await applySettings(fake.appRest(), REPO, APP, BASELINE);
    const before = fake.snapshot();
    const from = fake.calls.length;

    const again = await applySettings(fake.appRest(), REPO, APP, BASELINE);

    expect(again.changed).toEqual([]);
    expect(again.remaining).toEqual([]);
    expect(writesSince(fake, from)).toEqual([]);
    expect(fake.snapshot()).toEqual(before);
  });

  it("applies Free settings and reruns without accessing paid endpoints", async () => {
    const fake = await provisioned();
    const { rest, paidCalls } = freePlanClient(fake);
    const from = fake.calls.length;

    const result = await applySettings(rest, REPO, APP, FREE_BASELINE);

    expect(result.remaining).toEqual([]);
    expect(result.changed.map((d) => d.setting)).toEqual([
      "merge.allow_merge_commit",
      "merge.allow_rebase_merge",
      "merge.delete_branch_on_merge",
      "actions.enabled",
    ]);
    expect(writesSince(fake, from)).toEqual([
      { method: "PATCH", path: ROOT },
      { method: "PUT", path: `${ROOT}/actions/permissions` },
    ]);
    const applied = fake.snapshot();
    const rerunFrom = fake.calls.length;

    const again = await applySettings(rest, REPO, APP, FREE_BASELINE);

    expect(again.changed).toEqual([]);
    expect(again.remaining).toEqual([]);
    expect(writesSince(fake, rerunFrom)).toEqual([]);
    expect(fake.snapshot()).toEqual(applied);
    expect(paidCalls).toEqual([]);
  });

  it("preserves existing protections and environments when they become unmanaged", async () => {
    const fake = await provisioned();
    await applySettings(fake.appRest(), REPO, APP, BASELINE);
    await fake.appRest().request("POST", `${ROOT}/rulesets`, {
      name: "Customer rules",
      target: "branch",
      enforcement: "active",
      rules: [{ type: "deletion" }],
    });
    await fake.appRest().request("PUT", `${ROOT}/environments/customer`, {
      deployment_branch_policy: null,
    });
    const before = fake.snapshot();
    await fake.appRest().request("PUT", `${ROOT}/actions/permissions`, { enabled: true });
    const { rest, paidCalls } = freePlanClient(fake);

    const result = await applySettings(rest, REPO, APP, FREE_BASELINE);

    expect(result.remaining).toEqual([]);
    expect(fake.snapshot()).toEqual(before);
    expect(paidCalls).toEqual([]);
  });

  for (const status of [403, 500]) {
    for (const [method, path] of [
      ["GET", ROOT],
      ["GET", `${ROOT}/actions/permissions`],
      ["PATCH", ROOT],
      ["PUT", `${ROOT}/actions/permissions`],
    ] as const) {
      it(`propagates ${status} from ${method} ${path} with the Free baseline`, async () => {
        const fake = await provisioned();
        fake.failNext({ method, path, status });
        const { rest, paidCalls } = freePlanClient(fake);

        await expect(applySettings(rest, REPO, APP, FREE_BASELINE)).rejects.toBeInstanceOf(
          GitHubApiError,
        );
        expect(paidCalls).toEqual([]);
      });
    }
  }

  it("switches the default branch to main", async () => {
    const fake = await provisioned();
    await fake.appRest().request("POST", `${ROOT}/git/refs`, {
      ref: "refs/heads/master",
      sha: await headOf(fake, "main"),
    });
    await fake.appRest().request("PATCH", ROOT, { default_branch: "master" });

    const result = await applySettings(fake.appRest(), REPO, APP, BASELINE);
    expect(result.changed).toContainEqual({
      setting: "default_branch",
      expected: "main",
      actual: "master",
    });
    expect(result.remaining).toEqual([]);
    expect(result.observed.default_branch).toBe("main");
  });

  it("makes a public repository private", async () => {
    const fake = await provisioned();
    await fake.appRest().request("PATCH", ROOT, { visibility: "public" });
    const result = await applySettings(fake.appRest(), REPO, APP, BASELINE);
    expect(result.changed).toContainEqual({
      setting: "visibility",
      expected: "private",
      actual: "public",
    });
    expect(result.observed.visibility).toBe("private");
    expect(result.remaining).toEqual([]);
  });

  it("updates a ruleset that drifted in place", async () => {
    const fake = await provisioned();
    const first = await applySettings(fake.appRest(), REPO, APP, BASELINE);
    const id = need(first.observed.rulesets.oxagen_steering, "steering").id;
    await fake.appRest().request("PUT", `${ROOT}/rulesets/${id}`, { enforcement: "disabled" });
    const from = fake.calls.length;

    const result = await applySettings(fake.appRest(), REPO, APP, BASELINE);

    expect(result.changed.map((d) => d.setting)).toEqual(["rulesets.oxagen_steering.enforcement"]);
    expect(writesSince(fake, from)).toEqual([{ method: "PUT", path: `${ROOT}/rulesets/${id}` }]);
    expect(result.remaining).toEqual([]);
    expect(result.observed.rulesets.oxagen_steering?.id).toBe(id);
  });

  it("removes a deployment branch the baseline does not allow", async () => {
    const fake = await provisioned();
    await applySettings(fake.appRest(), REPO, APP, BASELINE);
    const clean = fake.snapshot();
    await fake
      .appRest()
      .request("POST", `${ROOT}/environments/steering/deployment-branch-policies`, {
        name: "develop",
        type: "branch",
      });
    const from = fake.calls.length;

    const result = await applySettings(fake.appRest(), REPO, APP, BASELINE);

    expect(result.remaining).toEqual([]);
    expect(writesSince(fake, from).map((c) => c.method)).toEqual(["PUT", "DELETE"]);
    expect(fake.snapshot()).toEqual(clean);
  });

  it("narrows an environment that accepts every branch", async () => {
    const fake = await provisioned();
    await fake
      .appRest()
      .request("PUT", `${ROOT}/environments/steering`, { deployment_branch_policy: null });
    const result = await applySettings(fake.appRest(), REPO, APP, BASELINE);
    expect(result.changed).toContainEqual({
      setting: "environments.steering.deployment_branches",
      expected: ["main"],
      actual: ["*"],
    });
    expect(result.remaining).toEqual([]);
  });

  it("leaves a customer's own ruleset in place", async () => {
    const fake = await provisioned();
    await fake.appRest().request("POST", `${ROOT}/rulesets`, {
      name: "Customer rules",
      target: "branch",
      enforcement: "active",
      rules: [{ type: "deletion" }],
    });
    const result = await applySettings(fake.appRest(), REPO, APP, BASELINE);
    expect(result.remaining).toEqual([]);
    expect(Object.keys(result.observed.rulesets).sort()).toEqual([
      "customer_rules",
      "oxagen_merges",
      "oxagen_steering",
    ]);
  });

  it("reports what still differs when GitHub ignores a write", async () => {
    const fake = await provisioned();
    // The PUT answers 204 without reaching the fake, so Actions stay on.
    const fetch: HttpFetch = (url, init) =>
      init.method === "PUT" && url.endsWith("/actions/permissions")
        ? Promise.resolve({ status: 204, text: () => Promise.resolve("") })
        : fake.fetch(url, init);
    const rest = createGithubRest({ token: "app-token", fetch });
    const result = await applySettings(rest, REPO, APP, BASELINE);
    expect(result.remaining).toEqual([
      { setting: "actions.enabled", expected: false, actual: true },
    ]);
  });

  for (const when of ["before", "after"] as const) {
    it(`converges on a rerun after a failure ${when} GitHub applies each write`, async () => {
      const clean = await cleanApply();
      expect(clean.writes).toHaveLength(6);

      for (let n = 1; n <= clean.writes.length; n++) {
        const label = `write ${n}: ${clean.writes[n - 1]?.method} ${clean.writes[n - 1]?.path}`;
        const fake = await provisioned();

        const failed = await applySettings(failingWrite(fake, n, when), REPO, APP, BASELINE).then(
          () => null,
          (e: unknown) => e,
        );
        expect(failed, label).toBeInstanceOf(GitHubApiError);

        const rerun = await applySettings(fake.appRest(), REPO, APP, BASELINE);
        expect(rerun.remaining, label).toEqual([]);
        expect(fake.snapshot(), label).toEqual(clean.snapshot);
      }
    });
  }
});

describe("applySettings and recordDeployment together", () => {
  it("reads the steering app as the deployer once version 1 is recorded", async () => {
    const fake = await provisioned();
    await applySettings(fake.appRest(), REPO, APP, BASELINE);
    await recordDeployment(fake.appRest(), {
      repo: REPO,
      environment: "steering",
      ref: "main",
      sha: await headOf(fake, "main"),
      version: 1,
      description: "Version 1",
    });
    const read = await readSettings(fake.appRest(), REPO, APP, ENVIRONMENTS);
    expect(compareSettings(BASELINE, read, { require_deployment: true })).toEqual([]);
  });
});
