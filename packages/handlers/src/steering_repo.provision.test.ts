// steering_repo.provision.test.ts: the steering repo provisioning steps, run
// against the in-memory GitHub and GitLab fakes (lane S1, #4450).
//
// The dependencies live in memory: state and connection per scope in maps,
// with every save, bind, and re-authorize banner recorded. The real
// dependency factory has its own test in steering_repo.provision.deps.test.ts.
import * as gh from "@oxagen/github/provision";
import {
  FakeGithub,
  type FakeGithubOptions,
} from "@oxagen/github/provision/testing";
import {
  GitLabApiError,
  type GitlabRest,
  type GitlabResponse,
  type SteeringGroup,
  SteeringGitlabReauthorizeError,
} from "@oxagen/gitlab/provision";
import { FakeGitlab } from "@oxagen/gitlab/provision/testing";
import {
  firstCommitFiles,
  GITHUB_SETTINGS_BASELINE,
  OXAGEN_STEERING_APP,
} from "@oxagen/oxagen/steering-repo";
import { describe, expect, it, vi } from "vitest";
import { steeringHookTarget } from "./lib/steering-hook";
import {
  FIRST_COMMIT_MESSAGE,
  initialSteeringRepoState,
  isSteeringRepoStep,
  provisionSteeringRepo,
  readSteeringConnection,
  readSteeringRepoState,
  REAUTHORIZE,
  runSteeringRepoStep,
  STEERING_REPO_STEPS,
  SteeringProvisionBlockedError,
  steeringRepoMarker,
  type ProvisionDeps,
  type ProvisionTarget,
  type SteeringConnection,
  type SteeringRepoScope,
  type SteeringRepoState,
  type SteeringRepoStep,
  type SteeringRepository,
  type StepOutcome,
} from "./steering_repo.provision";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-26T12:00:00.000Z");
const ORG = "acme";
const APP: gh.SteeringApp = {
  symbol: OXAGEN_STEERING_APP,
  id: 9001,
  slug: "oxagen-steering-test",
};
const WS: SteeringRepoScope = {
  kind: "workspace",
  orgId: "org_1",
  workspaceId: "ws_1",
};
const ORG_SCOPE: SteeringRepoScope = { kind: "organization", orgId: "org_1" };
const WORKSPACE_TARGET: ProvisionTarget = {
  org_slug: ORG,
  workspace: { slug: "support", name: "Support" },
};
const ORG_TARGET: ProvisionTarget = { org_slug: ORG, workspace: null };
const GROUP: SteeringGroup = { id: 42, full_path: ORG };
const BOT = { user_id: 7, username: "group_42_bot" };
const BINDING_ID = "rpb_test";
const HOOK_SECRET = "a-steering-hook-secret-of-32-chars!";
const API_URL = "https://api.example.test";

/** The hook a steering project should carry, with the secret it was made with. */
function hookOf(
  scope: SteeringRepoScope,
  projectId: number,
  secret = HOOK_SECRET,
): { url: string; token: string } {
  return steeringHookTarget(
    {
      kind: scope.kind,
      scopeId: scope.kind === "workspace" ? scope.workspaceId : scope.orgId,
      projectId,
    },
    { BETTER_AUTH_SECRET: secret, NEXT_PUBLIC_API_URL: API_URL },
  );
}

const GITHUB_CONNECTION: SteeringConnection = {
  provider: "github",
  installation_id: 77,
  account_login: ORG,
};
const GITLAB_CONNECTION: SteeringConnection = {
  provider: "gitlab",
  group_id: 42,
  group_path: ORG,
};

const WORKSPACE_DESCRIPTION =
  "Steering records for the Support workspace. Oxagen manages this repository. oxagen-scope:ws_1";
const ORG_DESCRIPTION =
  "Steering records for the acme organization. Oxagen manages this repository. oxagen-scope:org_1";

const GITHUB_REPOSITORY: SteeringRepository = {
  id: 101,
  owner: ORG,
  name: "oxagen-support",
  full_name: "acme/oxagen-support",
  initial_branch: "main",
};
const GITLAB_REPOSITORY: SteeringRepository = {
  id: 1,
  owner: ORG,
  name: "oxagen-support",
  full_name: "acme/oxagen-support",
  initial_branch: "main",
};

/** The first commit's files for the workspace or the organization repo. */
function seedFilesOf(
  provider: "github" | "gitlab",
  repository: string,
  workspace: boolean,
): Record<string, string> {
  const files = workspace
    ? firstCommitFiles({
        provider,
        organization: ORG,
        repository,
        scope: { kind: "workspace", slug: "support", label: "Support" },
      })
    : firstCommitFiles({
        provider,
        organization: ORG,
        repository,
        scope: { kind: "organization" },
      });
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

/** The rulesets the fake should hold, in the fake's order. */
function expectedRulesets(): unknown[] {
  return Object.values(GITHUB_SETTINGS_BASELINE.rulesets)
    .map(
      (r) =>
        JSON.parse(JSON.stringify(gh.rulesetBody(APP, r))) as { name: string },
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface GithubRepoSnapshot {
  name: string;
  description: string;
  private: boolean;
  visibility: string;
  default_branch: string;
  branches: Record<string, string>;
  files: Record<string, Record<string, string>>;
  merge: Record<string, boolean>;
  actions_enabled: boolean;
  rulesets: unknown[];
  environments: Record<string, unknown>;
  deployments: {
    sha: string;
    ref: string;
    environment: string;
    payload: unknown;
    description: string;
    latest_status: string | null;
  }[];
  in_installation: boolean;
}

function githubRepo(
  hub: FakeGithub,
  name: string,
): GithubRepoSnapshot | undefined {
  const snap = hub.snapshot() as {
    repositories: Record<string, GithubRepoSnapshot>;
  };
  return snap.repositories[name];
}

function githubFake(
  opts: Partial<Omit<FakeGithubOptions, "org" | "app">> = {},
): FakeGithub {
  return new FakeGithub({ org: ORG, app: APP, ...opts });
}

function gitlabFake(): FakeGitlab {
  return new FakeGitlab({ group: GROUP, bot: BOT });
}

// ── The in-memory dependencies ───────────────────────────────────────────────

interface GitlabCall {
  method: string;
  path: string;
  body: unknown;
}

/** A GitLab client that records every request body before it sends it. */
function recording(rest: GitlabRest, log: GitlabCall[]): GitlabRest {
  return {
    request<T>(
      method: string,
      path: string,
      body?: unknown,
      accept?: readonly number[],
    ): Promise<GitlabResponse<T>> {
      log.push({ method, path, body });
      return rest.request<T>(method, path, body, accept);
    },
  };
}

function keyOf(scope: SteeringRepoScope): string {
  return scope.kind === "workspace"
    ? `workspace:${scope.workspaceId}`
    : `organization:${scope.orgId}`;
}

class Harness {
  readonly states = new Map<string, SteeringRepoState>();
  /** Keyed by orgId, as the organization's settings hold it. */
  readonly connections = new Map<string, SteeringConnection>();
  readonly saves: SteeringRepoState[] = [];
  readonly savedConnections: SteeringConnection[] = [];
  readonly binds: {
    scope: SteeringRepoScope;
    connection: SteeringConnection;
    repository: SteeringRepository;
    default_branch: string;
  }[] = [];
  readonly notified: {
    scope: SteeringRepoScope;
    provider: "github" | "gitlab";
  }[] = [];
  readonly gitlabCalls: GitlabCall[] = [];
  /** How many more times each dependency fails. */
  readonly faults = { bind: 0, groups: 0 };
  userToken = true;
  groupToken = true;
  /** GitLab refuses the stored group token while the groups are listed. */
  groupsRefused = false;
  githubConfigured = true;
  workspaceGone = false;
  /** The secret the hook's token is made with. A test rotates it. */
  hookSecret = HOOK_SECRET;
  /** Every scope and project the hook step asked a target for. */
  readonly hookRequests: { scope: SteeringRepoScope; projectId: number }[] = [];

  constructor(
    readonly hub: FakeGithub | null,
    readonly lab: FakeGitlab | null,
  ) {}

  state(scope: SteeringRepoScope): SteeringRepoState | undefined {
    return this.states.get(keyOf(scope));
  }

  deps(): ProvisionDeps {
    return {
      now: () => NOW,
      load: (scope) => {
        if (this.workspaceGone && scope.kind === "workspace")
          return Promise.reject(
            new SteeringProvisionBlockedError(
              "workspace_not_found",
              `Workspace ${scope.workspaceId} no longer exists.`,
            ),
          );
        const state = this.states.get(keyOf(scope));
        const connection = this.connections.get(scope.orgId);
        return Promise.resolve({
          target: scope.kind === "workspace" ? WORKSPACE_TARGET : ORG_TARGET,
          state: state === undefined ? null : structuredClone(state),
          connection:
            connection === undefined ? null : structuredClone(connection),
        });
      },
      saveState: (scope, state) => {
        this.states.set(keyOf(scope), structuredClone(state));
        this.saves.push(structuredClone(state));
        return Promise.resolve();
      },
      saveConnection: (scope, connection) => {
        this.connections.set(scope.orgId, structuredClone(connection));
        this.savedConnections.push(structuredClone(connection));
        return Promise.resolve();
      },
      github: () => {
        const hub = this.hub;
        if (hub === null || !this.githubConfigured) return null;
        return {
          app: APP,
          installation: () => Promise.resolve(hub.appRest()),
          user: () => Promise.resolve(this.userToken ? hub.userRest() : null),
        };
      },
      gitlab: () => ({
        groups: () => {
          if (this.groupsRefused)
            return Promise.reject(
              new SteeringGitlabReauthorizeError("401 Unauthorized"),
            );
          if (this.faults.groups > 0) {
            this.faults.groups -= 1;
            return Promise.reject(new Error("listing the groups failed"));
          }
          return Promise.resolve(
            this.lab !== null && this.groupToken ? [GROUP] : [],
          );
        },
        group: (groupId) => {
          const lab = this.lab;
          if (lab === null || !this.groupToken || groupId !== GROUP.id)
            return Promise.resolve(null);
          return Promise.resolve(recording(lab.rest(), this.gitlabCalls));
        },
      }),
      bind: (scope, args) => {
        if (this.faults.bind > 0) {
          this.faults.bind -= 1;
          return Promise.reject(new Error("the binding write failed"));
        }
        this.binds.push({ scope, ...structuredClone(args) });
        return Promise.resolve(BINDING_ID);
      },
      notifyReauthorize: (scope, provider) => {
        this.notified.push({ scope, provider });
        return Promise.resolve();
      },
      steeringHook: (scope, projectId) => {
        this.hookRequests.push({ scope, projectId });
        return hookOf(scope, projectId, this.hookSecret);
      },
    };
  }
}

/**
 * Run the steps in order from `from` and stop at the first that throws.
 * Returns what it threw, or null when every step finished.
 */
async function runUntilStopped(
  deps: ProvisionDeps,
  scope: SteeringRepoScope,
  from: SteeringRepoStep = "pick_connection",
): Promise<unknown> {
  const start = STEERING_REPO_STEPS.indexOf(from);
  for (const step of STEERING_REPO_STEPS.slice(start)) {
    try {
      await runSteeringRepoStep(deps, scope, step);
    } catch (err) {
      return err;
    }
  }
  return null;
}

/** Run one step and return what it threw, or fail the test if it finished. */
async function stepError(
  deps: ProvisionDeps,
  scope: SteeringRepoScope,
  step: SteeringRepoStep,
): Promise<unknown> {
  const outcome = await runSteeringRepoStep(deps, scope, step).then(
    (value) => ({ threw: false as const, value }),
    (err: unknown) => ({ threw: true as const, err }),
  );
  if (!outcome.threw)
    throw new Error(`${step} finished but the test expected it to stop`);
  return outcome.err;
}

async function cleanGithubRun(
  scope: SteeringRepoScope,
): Promise<{ snapshot: unknown; state: SteeringRepoState | undefined }> {
  const hub = githubFake();
  const h = new Harness(hub, null);
  expect(await provisionSteeringRepo(h.deps(), scope)).toBe("ready");
  return { snapshot: hub.snapshot(), state: h.state(scope) };
}

async function cleanGitlabRun(
  scope: SteeringRepoScope,
): Promise<{ snapshot: unknown; state: SteeringRepoState | undefined }> {
  const lab = gitlabFake();
  const h = new Harness(null, lab);
  expect(await provisionSteeringRepo(h.deps(), scope)).toBe("ready");
  return { snapshot: lab.snapshot(), state: h.state(scope) };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("the step names", () => {
  it.each([...STEERING_REPO_STEPS])("accepts %s", (step) => {
    expect(isSteeringRepoStep(step)).toBe(true);
  });

  it.each(["", "bind", "Pick_connection", "publish"])("refuses %j", (name) => {
    expect(isSteeringRepoStep(name)).toBe(false);
  });
});

describe("initialSteeringRepoState", () => {
  it("starts provisioning on the first name with nothing made", () => {
    expect(initialSteeringRepoState(NOW)).toEqual({
      status: "provisioning",
      step: null,
      failed_step: null,
      error: null,
      provider: null,
      attempt: 1,
      candidate: null,
      repository: null,
      commit_sha: null,
      deployment_id: null,
      binding_id: null,
      updated_at: "2026-09-26T12:00:00.000Z",
    });
  });
});

describe("steeringRepoMarker", () => {
  it("names the workspace for a workspace repo", () => {
    expect(steeringRepoMarker(WS)).toBe("oxagen-scope:ws_1");
  });

  it("names the organization for the organization repo", () => {
    expect(steeringRepoMarker(ORG_SCOPE)).toBe("oxagen-scope:org_1");
  });
});

describe("the settings readers", () => {
  it("fills the fields a stored state leaves out", () => {
    expect(
      readSteeringRepoState({
        steering_repo: { status: "ready", step: "bind_repository" },
      }),
    ).toEqual({
      ...initialSteeringRepoState(new Date(0)),
      status: "ready",
      step: "bind_repository",
    });
  });

  it.each([null, "text", {}, { steering_repo: { step: "pick_connection" } }])(
    "reads no state from %j",
    (settings) => {
      expect(readSteeringRepoState(settings)).toBeNull();
    },
  );

  it("reads a GitHub and a GitLab connection", () => {
    expect(
      readSteeringConnection({ steering_connection: GITHUB_CONNECTION }),
    ).toEqual(GITHUB_CONNECTION);
    expect(
      readSteeringConnection({ steering_connection: GITLAB_CONNECTION }),
    ).toEqual(GITLAB_CONNECTION);
  });

  it("reads no connection from a malformed one", () => {
    expect(
      readSteeringConnection({
        steering_connection: { provider: "github", installation_id: "77" },
      }),
    ).toBeNull();
    expect(readSteeringConnection(null)).toBeNull();
  });
});

// ── GitHub ───────────────────────────────────────────────────────────────────

describe("a GitHub workspace", () => {
  it("runs each step and records what it made", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    const deps = h.deps();
    const repo = () => githubRepo(hub, "oxagen-support");

    expect(await runSteeringRepoStep(deps, WS, "pick_connection")).toEqual({
      step: "pick_connection",
      status: "provisioning",
      ran: true,
    });
    expect(h.savedConnections).toEqual([GITHUB_CONNECTION]);
    expect(h.state(WS)).toMatchObject({
      status: "provisioning",
      step: "pick_connection",
      provider: "github",
      repository: null,
    });
    expect(hub.writes()).toEqual([]);

    expect(await runSteeringRepoStep(deps, WS, "create_repository")).toEqual({
      step: "create_repository",
      status: "provisioning",
      ran: true,
    });
    expect(h.state(WS)).toMatchObject({
      step: "create_repository",
      attempt: 1,
      candidate: "oxagen-support",
      repository: GITHUB_REPOSITORY,
    });
    expect(repo()).toMatchObject({
      private: true,
      visibility: "private",
      description: WORKSPACE_DESCRIPTION,
      in_installation: false,
    });

    await runSteeringRepoStep(deps, WS, "add_to_installation");
    expect(h.state(WS)?.step).toBe("add_to_installation");
    expect(repo()?.in_installation).toBe(true);

    await runSteeringRepoStep(deps, WS, "write_first_commit");
    const sha = h.state(WS)?.commit_sha;
    expect(typeof sha).toBe("string");
    expect(repo()?.branches).toEqual({ main: sha });
    expect(repo()?.files).toEqual({
      main: seedFilesOf("github", "acme/oxagen-support", true),
    });

    await runSteeringRepoStep(deps, WS, "apply_settings");
    expect(h.state(WS)?.step).toBe("apply_settings");
    expect(repo()).toMatchObject({
      default_branch: "main",
      merge: GITHUB_SETTINGS_BASELINE.merge,
      actions_enabled: false,
      rulesets: expectedRulesets(),
      environments: {
        steering: {
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
          branch_policies: ["branch:main"],
        },
      },
    });

    await runSteeringRepoStep(deps, WS, "publish_version");
    expect(repo()?.deployments).toEqual([
      {
        sha,
        ref: "main",
        environment: "steering",
        payload: { version: 1 },
        description: "Version 1",
        latest_status: "success",
      },
    ]);
    expect(h.state(WS)).toMatchObject({
      status: "provisioning",
      step: "publish_version",
      deployment_id: expect.any(Number),
    });

    expect(await runSteeringRepoStep(deps, WS, "bind_repository")).toEqual({
      step: "bind_repository",
      status: "ready",
      ran: true,
    });
    expect(h.binds).toEqual([
      {
        scope: WS,
        connection: GITHUB_CONNECTION,
        repository: GITHUB_REPOSITORY,
        default_branch: "main",
      },
    ]);
    expect(h.state(WS)).toEqual({
      status: "ready",
      step: "bind_repository",
      failed_step: null,
      error: null,
      provider: "github",
      attempt: 1,
      candidate: "oxagen-support",
      repository: GITHUB_REPOSITORY,
      commit_sha: sha,
      deployment_id: expect.any(Number),
      binding_id: BINDING_ID,
      updated_at: NOW.toISOString(),
    });
    expect(h.notified).toEqual([]);
  });

  it("leaves the fake holding exactly the prescribed repository", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    const sha = h.state(WS)?.commit_sha;
    expect(hub.snapshot()).toEqual({
      org: ORG,
      repositories: {
        "oxagen-support": {
          name: "oxagen-support",
          description: WORKSPACE_DESCRIPTION,
          private: true,
          visibility: "private",
          default_branch: "main",
          branches: { main: sha },
          files: { main: seedFilesOf("github", "acme/oxagen-support", true) },
          merge: GITHUB_SETTINGS_BASELINE.merge,
          actions_enabled: false,
          rulesets: expectedRulesets(),
          environments: {
            steering: {
              deployment_branch_policy: {
                protected_branches: false,
                custom_branch_policies: true,
              },
              branch_policies: ["branch:main"],
            },
          },
          deployments: [
            {
              sha,
              ref: "main",
              environment: "steering",
              payload: { version: 1 },
              description: "Version 1",
              latest_status: "success",
            },
          ],
          in_installation: true,
        },
      },
    });
  });

  it("commits the seed files as one root commit with the first commit message", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    await provisionSteeringRepo(h.deps(), WS);
    const sha = h.state(WS)?.commit_sha ?? "";
    const res = await hub
      .appRest()
      .request<{ message: string; parents: unknown[] }>(
        "GET",
        `/repos/acme/oxagen-support/git/commits/${sha}`,
      );
    expect(res.data).toMatchObject({
      message: FIRST_COMMIT_MESSAGE,
      parents: [],
    });
  });

  it("moves the default branch to main when the org starts repos on another branch", async () => {
    const hub = githubFake({ org_default_branch: "master" });
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.state(WS)?.repository?.initial_branch).toBe("master");
    const repo = githubRepo(hub, "oxagen-support");
    expect(repo?.default_branch).toBe("main");
    expect(Object.keys(repo?.branches ?? {})).toEqual(["main"]);
  });

  it("skips the installation write when the installation covers every repository", async () => {
    const hub = githubFake({ repository_selection: "all" });
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(
      hub
        .writes()
        .filter((w) => w.method === "PUT" && w.path.startsWith("/user/")),
    ).toEqual([]);
    expect(h.state(WS)?.step).toBe("bind_repository");
  });

  it("runs the steps in order, and a second run on a ready state changes nothing", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    // The create step saves once when it tries a name, before it finishes.
    expect(h.saves.map((s) => s.step)).toEqual([
      "pick_connection",
      "pick_connection",
      "create_repository",
      "add_to_installation",
      "write_first_commit",
      "apply_settings",
      "publish_version",
      "bind_repository",
    ]);

    const snapshot = hub.snapshot();
    const state = h.state(WS);
    const writes = hub.writes().length;
    const saves = h.saves.length;

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(hub.snapshot()).toEqual(snapshot);
    expect(h.state(WS)).toEqual(state);
    expect(h.saves.slice(saves).every((s) => s.error === null)).toBe(true);
    // The rerun sends the installation add again, which answers 304, and
    // builds the tree to compare it with main. Neither changes the repo.
    expect(hub.writes().slice(writes)).toEqual([
      { method: "PUT", path: "/user/installations/77/repositories/101" },
      { method: "POST", path: "/repos/acme/oxagen-support/git/trees" },
    ]);
    expect(h.binds).toHaveLength(2);
    expect(h.savedConnections).toHaveLength(1);
  });
});

// ── GitLab ───────────────────────────────────────────────────────────────────

describe("a GitLab workspace", () => {
  it("runs each step and records what it made", async () => {
    const lab = gitlabFake();
    const h = new Harness(null, lab);
    const deps = h.deps();
    const outcomes: StepOutcome[] = [];
    for (const step of STEERING_REPO_STEPS)
      outcomes.push(await runSteeringRepoStep(deps, WS, step));

    expect(outcomes).toEqual([
      { step: "pick_connection", status: "provisioning", ran: true },
      { step: "create_repository", status: "provisioning", ran: true },
      { step: "add_to_installation", status: "provisioning", ran: false },
      { step: "write_first_commit", status: "provisioning", ran: true },
      { step: "apply_settings", status: "provisioning", ran: true },
      { step: "register_webhook", status: "provisioning", ran: true },
      { step: "publish_version", status: "provisioning", ran: true },
      { step: "bind_repository", status: "ready", ran: true },
    ]);
    expect(h.savedConnections).toEqual([GITLAB_CONNECTION]);
    expect(lab.writes()).toEqual([
      { method: "POST", path: "/projects" },
      { method: "POST", path: "/projects/1/repository/commits" },
      { method: "PUT", path: "/projects/1" },
      { method: "POST", path: "/projects/1/approvals" },
      { method: "POST", path: "/projects/1/protected_branches" },
      { method: "POST", path: "/projects/1/hooks" },
      { method: "POST", path: "/projects/1/deployments" },
    ]);

    const sha = h.state(WS)?.commit_sha;
    expect(typeof sha).toBe("string");
    expect(lab.snapshot()).toEqual({
      projects: {
        "acme/oxagen-support": {
          name: "oxagen-support",
          path: "oxagen-support",
          description: WORKSPACE_DESCRIPTION,
          visibility: "private",
          default_branch: "main",
          branches: {
            main: {
              sha,
              files: seedFilesOf("gitlab", "acme/oxagen-support", true),
            },
          },
          settings: {
            squash_option: "always",
            only_allow_merge_if_pipeline_succeeds: true,
            remove_source_branch_after_merge: true,
            reset_approvals_on_push: true,
            builds_access_level: "disabled",
          },
          protected_branches: {
            main: {
              push_access_levels: [
                { access_level: 0, user_id: null, group_id: null },
              ],
              merge_access_levels: [
                { access_level: 0, user_id: null, group_id: null },
                { access_level: 40, user_id: BOT.user_id, group_id: null },
              ],
              allow_force_push: false,
            },
          },
          deployments: [
            { environment: "steering", ref: "main", sha, status: "success" },
          ],
          hooks: [
            {
              url: hookOf(WS, 1).url,
              push_events: true,
              merge_requests_events: true,
              enable_ssl_verification: true,
            },
          ],
        },
      },
    });
    expect(h.hookRequests).toEqual([{ scope: WS, projectId: 1 }]);
    expect(lab.hooks(1)).toEqual([
      {
        id: 1,
        ...hookOf(WS, 1),
        push_events: true,
        merge_requests_events: true,
        enable_ssl_verification: true,
      },
    ]);
    expect(hookOf(WS, 1).url).toBe(
      `${API_URL}/webhooks/gitlab/steering/workspace/ws_1`,
    );

    const commit = h.gitlabCalls.find(
      (c) => c.method === "POST" && c.path === "/projects/1/repository/commits",
    );
    expect(commit?.body).toMatchObject({
      branch: "main",
      commit_message: FIRST_COMMIT_MESSAGE,
    });

    expect(h.binds).toEqual([
      {
        scope: WS,
        connection: GITLAB_CONNECTION,
        repository: GITLAB_REPOSITORY,
        default_branch: "main",
      },
    ]);
    expect(h.state(WS)).toEqual({
      status: "ready",
      step: "bind_repository",
      failed_step: null,
      error: null,
      provider: "gitlab",
      attempt: 1,
      candidate: "oxagen-support",
      repository: GITLAB_REPOSITORY,
      commit_sha: sha,
      deployment_id: 1,
      binding_id: BINDING_ID,
      updated_at: NOW.toISOString(),
    });
  });

  it("changes nothing on a second run over a ready state", async () => {
    const lab = gitlabFake();
    const h = new Harness(null, lab);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    const snapshot = lab.snapshot();
    const state = h.state(WS);
    const writes = lab.writes().length;
    const hooks = lab.hooks(1);

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(lab.snapshot()).toEqual(snapshot);
    expect(h.state(WS)).toEqual(state);
    expect(lab.hooks(1)).toEqual(hooks);
    // GitLab never returns a hook's token, so the rerun writes the current
    // one onto the same hook. That PUT is its one write.
    expect(lab.writes().slice(writes)).toEqual([
      { method: "PUT", path: "/projects/1/hooks/1" },
    ]);
  });

  it("writes the new token onto the same hook after the secret rotates", async () => {
    const lab = gitlabFake();
    const h = new Harness(null, lab);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    const rotated = "a-rotated-steering-hook-secret-of-32!";
    h.hookSecret = rotated;

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    const [hook, ...others] = lab.hooks(1);
    expect(others).toEqual([]);
    expect(hook).toMatchObject({ id: 1, ...hookOf(WS, 1, rotated) });
    expect(hook?.token).not.toBe(hookOf(WS, 1).token);
  });

  it("adopts a hook that already holds the URL and creates no second one", async () => {
    const lab = gitlabFake();
    const h = new Harness(null, lab);
    const deps = h.deps();
    for (const step of STEERING_REPO_STEPS.slice(
      0,
      STEERING_REPO_STEPS.indexOf("register_webhook"),
    ))
      await runSteeringRepoStep(deps, WS, step);
    const other = await lab
      .rest()
      .request<{ id: number }>("POST", "/projects/1/hooks", {
        url: "https://elsewhere.example.test/hook",
        token: "someone-else",
      });
    const stale = await lab
      .rest()
      .request<{ id: number }>("POST", "/projects/1/hooks", {
        url: hookOf(WS, 1).url,
        token: "a-stale-token",
        merge_requests_events: false,
      });

    await runSteeringRepoStep(deps, WS, "register_webhook");
    expect(lab.hooks(1)).toEqual([
      {
        id: other.data?.id,
        url: "https://elsewhere.example.test/hook",
        token: "someone-else",
        push_events: true,
        merge_requests_events: false,
        enable_ssl_verification: true,
      },
      {
        id: stale.data?.id,
        ...hookOf(WS, 1),
        push_events: true,
        merge_requests_events: true,
        enable_ssl_verification: true,
      },
    ]);
  });
});

describe("a GitLab hook URL that GitLab refuses", () => {
  it.each([400, 422])(
    "finishes the run and logs a warning on a %i",
    async (status) => {
      const lab = gitlabFake();
      const h = new Harness(null, lab);
      lab.failNext({
        method: "POST",
        path: "/projects/1/hooks",
        status,
        message: "Invalid url given",
        times: 3,
      });

      expect(await runUntilStopped(h.deps(), WS)).toBeNull();
      expect(lab.hooks(1)).toEqual([]);
      expect(h.state(WS)).toMatchObject({
        status: "ready",
        step: "bind_repository",
        failed_step: null,
        error: null,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: WS.orgId,
          scope: "workspace",
          projectId: 1,
          url: hookOf(WS, 1).url,
        }),
        expect.stringContaining("refused the steering hook's URL"),
      );
    },
  );

  it("registers the hook on a run after GitLab accepts the URL", async () => {
    const lab = gitlabFake();
    const h = new Harness(null, lab);
    lab.failNext({ method: "POST", path: "/projects/1/hooks", status: 422 });
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(lab.hooks(1)).toEqual([]);

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(lab.hooks(1)).toEqual([
      expect.objectContaining({ id: 1, ...hookOf(WS, 1) }),
    ]);
  });

  it("still fails the step on a 403, which is not a refused URL", async () => {
    const lab = gitlabFake();
    const h = new Harness(null, lab);
    lab.failNext({ method: "POST", path: "/projects/1/hooks", status: 403 });

    const err = await runUntilStopped(h.deps(), WS);
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(h.state(WS)).toMatchObject({
      status: "failed",
      failed_step: "register_webhook",
      error: { code: "step_failed" },
    });
  });

  it("fails the step when the hook's secret is missing", async () => {
    const lab = gitlabFake();
    const h = new Harness(null, lab);
    const deps: ProvisionDeps = {
      ...h.deps(),
      steeringHook: () => {
        throw new Error("BETTER_AUTH_SECRET is not set");
      },
    };

    const err = await runUntilStopped(deps, WS);
    expect(err).not.toBeInstanceOf(SteeringProvisionBlockedError);
    expect(h.state(WS)).toMatchObject({
      status: "failed",
      failed_step: "register_webhook",
      error: { code: "step_failed", message: "BETTER_AUTH_SECRET is not set" },
    });
    expect(lab.hooks(1)).toEqual([]);
  });
});

// ── Organization scope ───────────────────────────────────────────────────────

describe("the organization repo", () => {
  it("creates <org>/oxagen with no workspace.toml and binds nothing", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    const deps = h.deps();
    const outcomes: StepOutcome[] = [];
    for (const step of STEERING_REPO_STEPS)
      outcomes.push(await runSteeringRepoStep(deps, ORG_SCOPE, step));

    expect(outcomes.map((o) => [o.step, o.status, o.ran])).toEqual([
      ["pick_connection", "provisioning", true],
      ["create_repository", "provisioning", true],
      ["add_to_installation", "provisioning", true],
      ["write_first_commit", "provisioning", true],
      ["apply_settings", "provisioning", true],
      ["register_webhook", "provisioning", false],
      ["publish_version", "ready", true],
      ["bind_repository", "ready", false],
    ]);
    expect(h.hookRequests).toEqual([]);
    const repo = githubRepo(hub, "oxagen");
    expect(repo?.description).toBe(ORG_DESCRIPTION);
    const files = seedFilesOf("github", "acme/oxagen", false);
    expect(files["workspace.toml"]).toBeUndefined();
    expect(repo?.files).toEqual({ main: files });
    expect(h.binds).toEqual([]);
    expect(h.state(ORG_SCOPE)).toMatchObject({
      status: "ready",
      step: "publish_version",
      repository: { name: "oxagen", full_name: "acme/oxagen" },
      binding_id: null,
    });
    expect(h.state(WS)).toBeUndefined();
  });

  it("returns ready from a full run", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), ORG_SCOPE)).toBe("ready");
    expect(h.binds).toEqual([]);
  });

  it("stops when another repository already holds the one name it may use", async () => {
    const hub = githubFake();
    hub.seedRepository({ name: "oxagen", description: "Someone else's." });
    const h = new Harness(hub, null);
    const err = await runUntilStopped(h.deps(), ORG_SCOPE);
    expect(err).toBeInstanceOf(SteeringProvisionBlockedError);
    expect(err).toMatchObject({ code: "repository_name_taken" });
    expect((err as Error).message).toContain(
      "Every name from oxagen to oxagen is taken in acme.",
    );
    expect(h.state(ORG_SCOPE)).toMatchObject({
      status: "blocked",
      failed_step: "create_repository",
      error: { code: "repository_name_taken" },
      repository: null,
    });
    expect(h.notified).toEqual([]);
  });
});

// ── pick_connection ──────────────────────────────────────────────────────────

describe("pick_connection", () => {
  it.each([
    {
      label: "a GitHub account that is not an organization",
      build: () => {
        const hub = githubFake({
          user_installations: [
            {
              id: 78,
              account_login: "someone",
              account_type: "User",
              repository_selection: "selected",
            },
          ],
        });
        return new Harness(hub, null);
      },
    },
    {
      label: "an unconfigured app and no group",
      build: () => {
        const h = new Harness(githubFake(), null);
        h.githubConfigured = false;
        return h;
      },
    },
  ])("blocks with no_connection given $label", async ({ build }) => {
    const h = build();
    const err = await stepError(h.deps(), WS, "pick_connection");
    expect(err).toBeInstanceOf(SteeringProvisionBlockedError);
    expect(err).toMatchObject({
      code: "no_connection",
      isNonRetriable: true,
      message:
        "This organization has no GitHub organization with Oxagen Steering installed and no GitLab group token. Connect one, then retry.",
    });
    expect(h.state(WS)).toMatchObject({
      status: "blocked",
      step: null,
      failed_step: "pick_connection",
      error: { code: "no_connection" },
    });
    expect(h.savedConnections).toEqual([]);
    expect(h.notified).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        scope: "workspace",
        step: "pick_connection",
        code: "no_connection",
      }),
      "steering_repo.provision: step did not finish",
    );
  });

  it.each([
    {
      label: "two GitHub organizations",
      build: () =>
        new Harness(
          githubFake({
            user_installations: [
              {
                id: 77,
                account_login: ORG,
                account_type: "Organization",
                repository_selection: "selected",
              },
              {
                id: 78,
                account_login: "acme-labs",
                account_type: "Organization",
                repository_selection: "selected",
              },
            ],
          }),
          null,
        ),
    },
    {
      label: "a GitHub organization and a GitLab group",
      build: () => new Harness(githubFake(), gitlabFake()),
    },
  ])("blocks with choose_connection given $label", async ({ build }) => {
    const h = build();
    const err = await stepError(h.deps(), WS, "pick_connection");
    expect(err).toMatchObject({
      code: "choose_connection",
      message:
        "This organization has 2 GitHub organizations and GitLab groups. Choose the one that holds steering repos, then retry.",
    });
    expect(h.state(WS)).toMatchObject({
      status: "blocked",
      failed_step: "pick_connection",
      error: { code: "choose_connection" },
    });
    expect(h.savedConnections).toEqual([]);
  });

  it("picks the one GitLab group when no owner has authorized GitHub", async () => {
    const h = new Harness(githubFake(), gitlabFake());
    h.userToken = false;
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    expect(h.savedConnections).toEqual([GITLAB_CONNECTION]);
    expect(h.state(WS)?.provider).toBe("gitlab");
  });

  it("honours a stored choice without listing the connections", async () => {
    const hub = githubFake();
    const h = new Harness(hub, gitlabFake());
    h.connections.set("org_1", GITLAB_CONNECTION);
    expect(await runSteeringRepoStep(h.deps(), WS, "pick_connection")).toEqual(
      { step: "pick_connection", status: "provisioning", ran: true },
    );
    expect(h.state(WS)?.provider).toBe("gitlab");
    expect(h.savedConnections).toEqual([]);
    expect(hub.calls).toEqual([]);
  });
});

// ── Steps that stop ──────────────────────────────────────────────────────────

describe("reauthorize", () => {
  async function expectReauthorize(
    h: Harness,
    step: SteeringRepoStep,
    provider: "github" | "gitlab",
  ): Promise<SteeringProvisionBlockedError> {
    const err = await stepError(h.deps(), WS, step);
    expect(err).toBeInstanceOf(SteeringProvisionBlockedError);
    expect(err).toMatchObject({
      name: "SteeringProvisionBlockedError",
      code: REAUTHORIZE,
      isNonRetriable: true,
    });
    expect(h.state(WS)).toMatchObject({
      status: "blocked",
      failed_step: step,
      error: { code: REAUTHORIZE },
    });
    expect(h.notified).toEqual([{ scope: WS, provider }]);
    return err as SteeringProvisionBlockedError;
  }

  it("stops at add_to_installation when no owner token is stored", async () => {
    const h = new Harness(githubFake(), null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    h.userToken = false;
    const deps = h.deps();
    await runSteeringRepoStep(deps, WS, "pick_connection");
    await runSteeringRepoStep(deps, WS, "create_repository");
    const err = await expectReauthorize(h, "add_to_installation", "github");
    expect(err.message).toBe(
      "No organization owner has authorized Oxagen Steering. An owner must authorize it.",
    );
    expect(h.state(WS)?.step).toBe("create_repository");
  });

  it("raises the banner once per stop, then resumes after an owner authorizes", async () => {
    const h = new Harness(githubFake(), null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    h.userToken = false;
    const deps = h.deps();
    await runSteeringRepoStep(deps, WS, "pick_connection");
    await runSteeringRepoStep(deps, WS, "create_repository");
    await expectReauthorize(h, "add_to_installation", "github");

    // A retry that stops for the same reason raises no second banner.
    await expect(
      runSteeringRepoStep(deps, WS, "add_to_installation"),
    ).rejects.toBeInstanceOf(SteeringProvisionBlockedError);
    expect(h.notified).toHaveLength(1);

    h.userToken = true;
    expect(await runUntilStopped(deps, WS, "add_to_installation")).toBeNull();
    expect(h.state(WS)).toMatchObject({
      status: "ready",
      failed_step: null,
      error: null,
    });
    expect(h.notified).toHaveLength(1);
  });

  it("stops at add_to_installation when GitHub refuses a revoked owner token", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    const deps = h.deps();
    await runSteeringRepoStep(deps, WS, "pick_connection");
    await runSteeringRepoStep(deps, WS, "create_repository");
    hub.revokeUserToken();
    const err = await expectReauthorize(h, "add_to_installation", "github");
    expect(err.message).toContain("(status 401)");
    expect(githubRepo(hub, "oxagen-support")?.in_installation).toBe(false);
  });

  it.each([401, 403])(
    "stops at add_to_installation when the installation add answers %i",
    async (status) => {
      const hub = githubFake();
      const h = new Harness(hub, null);
      const deps = h.deps();
      await runSteeringRepoStep(deps, WS, "pick_connection");
      await runSteeringRepoStep(deps, WS, "create_repository");
      hub.failNext({
        method: "PUT",
        path: "/user/installations/77/repositories/",
        status,
      });
      const err = await expectReauthorize(h, "add_to_installation", "github");
      expect(err.message).toContain(`(status ${status})`);
    },
  );

  it("stops when the owner token cannot reach the stored installation", async () => {
    const h = new Harness(githubFake({ user_installations: [] }), null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    const deps = h.deps();
    await runSteeringRepoStep(deps, WS, "pick_connection");
    await runSteeringRepoStep(deps, WS, "create_repository");
    const err = await expectReauthorize(h, "add_to_installation", "github");
    expect(err.message).toBe(
      "The stored Oxagen Steering authorization cannot reach the installation on acme. An owner must authorize it again.",
    );
  });

  it("stops at create_repository when GitLab refuses a revoked group token", async () => {
    const lab = gitlabFake();
    const h = new Harness(null, lab);
    const deps = h.deps();
    await runSteeringRepoStep(deps, WS, "pick_connection");
    lab.revokeToken();
    const err = await expectReauthorize(h, "create_repository", "gitlab");
    expect(err.message).toMatch(/^GitLab refused the steering token/);
    expect(lab.snapshot()).toEqual({ projects: {} });
  });

  it("names GitLab in the banner when GitLab refuses the token during pick_connection", async () => {
    const h = new Harness(null, gitlabFake());
    h.groupsRefused = true;
    const err = await expectReauthorize(h, "pick_connection", "gitlab");
    expect(err.message).toBe(
      "GitLab refused the steering token: 401 Unauthorized",
    );
    expect(h.state(WS)?.provider).toBeNull();
    expect(h.savedConnections).toEqual([]);
  });

  it("stops at create_repository when no group token is stored", async () => {
    const h = new Harness(null, gitlabFake());
    h.connections.set("org_1", GITLAB_CONNECTION);
    h.groupToken = false;
    const err = await expectReauthorize(h, "create_repository", "gitlab");
    expect(err.message).toBe(
      "No group access token is stored for acme. An owner must connect the group again.",
    );
  });
});

describe("other stops", () => {
  it("blocks without a banner when the Oxagen Steering app is not configured", async () => {
    const h = new Harness(githubFake(), null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    h.githubConfigured = false;
    const err = await stepError(h.deps(), WS, "create_repository");
    expect(err).toBeInstanceOf(SteeringProvisionBlockedError);
    expect(err).toMatchObject({ code: "steering_app_unconfigured" });
    expect(h.state(WS)).toMatchObject({
      status: "blocked",
      failed_step: "create_repository",
      error: { code: "steering_app_unconfigured" },
    });
    expect(h.notified).toEqual([]);
  });

  it("rejects with workspace_not_found and saves nothing when the workspace is gone", async () => {
    const h = new Harness(githubFake(), null);
    h.workspaceGone = true;
    const err = await stepError(h.deps(), WS, "pick_connection");
    expect(err).toBeInstanceOf(SteeringProvisionBlockedError);
    expect(err).toMatchObject({
      code: "workspace_not_found",
      isNonRetriable: true,
    });
    expect(h.saves).toEqual([]);
    expect(h.notified).toEqual([]);
  });

  it.each([
    {
      step: "create_repository" as const,
      connection: null,
      state: null,
      message: "the connection step has not recorded a connection",
    },
    {
      step: "write_first_commit" as const,
      connection: GITHUB_CONNECTION,
      state: null,
      message: "the create step has not recorded a repository",
    },
    {
      step: "publish_version" as const,
      connection: GITHUB_CONNECTION,
      state: { repository: GITHUB_REPOSITORY },
      message: "the first commit step has not recorded a commit",
    },
  ])(
    "fails $step when an earlier step has not run",
    async ({ step, connection, state, message }) => {
      const h = new Harness(githubFake(), null);
      if (connection !== null) h.connections.set("org_1", connection);
      if (state !== null)
        h.states.set(keyOf(WS), {
          ...initialSteeringRepoState(NOW),
          provider: "github",
          ...state,
        });
      const err = await stepError(h.deps(), WS, step);
      expect(err).not.toBeInstanceOf(SteeringProvisionBlockedError);
      expect((err as Error).message).toBe(message);
      expect(h.state(WS)).toMatchObject({
        status: "failed",
        failed_step: step,
        error: { code: "step_failed", message },
      });
    },
  );

  it("skips a step that does not apply without saving", async () => {
    const h = new Harness(null, gitlabFake());
    h.connections.set("org_1", GITLAB_CONNECTION);
    expect(
      await runSteeringRepoStep(h.deps(), WS, "add_to_installation"),
    ).toEqual({ step: "add_to_installation", status: "provisioning", ran: false });
    expect(
      await runSteeringRepoStep(h.deps(), ORG_SCOPE, "bind_repository"),
    ).toEqual({ step: "bind_repository", status: "provisioning", ran: false });
    expect(h.saves).toEqual([]);
  });

  it("skips the hook step on GitHub without asking for a target", async () => {
    const h = new Harness(githubFake(), null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    expect(
      await runSteeringRepoStep(h.deps(), WS, "register_webhook"),
    ).toEqual({ step: "register_webhook", status: "provisioning", ran: false });
    expect(h.hookRequests).toEqual([]);
    expect(h.saves).toEqual([]);
  });

  it("fails the hook step when the create step has not recorded a project", async () => {
    const h = new Harness(null, gitlabFake());
    h.connections.set("org_1", GITLAB_CONNECTION);
    const err = await stepError(h.deps(), WS, "register_webhook");
    expect((err as Error).message).toBe(
      "the create step has not recorded a repository",
    );
    expect(h.hookRequests).toEqual([]);
    expect(h.state(WS)).toMatchObject({
      status: "failed",
      failed_step: "register_webhook",
      error: { code: "step_failed" },
    });
  });
});

// ── Name collisions ──────────────────────────────────────────────────────────

describe("name collisions", () => {
  it("takes the next name on GitHub when another repository holds oxagen-<slug>", async () => {
    const hub = githubFake();
    const foreign = hub.seedRepository({
      name: "oxagen-support",
      description: "Another team's repository.",
    });
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.state(WS)).toMatchObject({
      attempt: 2,
      candidate: "oxagen-support-2",
      repository: {
        id: foreign + 1,
        owner: ORG,
        name: "oxagen-support-2",
        full_name: "acme/oxagen-support-2",
      },
    });
    expect(githubRepo(hub, "oxagen-support")).toMatchObject({
      description: "Another team's repository.",
      in_installation: false,
      rulesets: [],
    });
    expect(githubRepo(hub, "oxagen-support-2")?.description).toBe(
      WORKSPACE_DESCRIPTION,
    );
  });

  it("adopts a GitHub repository that carries this workspace's marker", async () => {
    const clean = await cleanGithubRun(WS);
    const hub = githubFake();
    const seeded = hub.seedRepository({
      name: "oxagen-support",
      description: WORKSPACE_DESCRIPTION,
    });
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.state(WS)).toMatchObject({
      attempt: 1,
      candidate: "oxagen-support",
      repository: { ...GITHUB_REPOSITORY, id: seeded },
    });
    expect(hub.snapshot()).toEqual(clean.snapshot);
  });

  it("takes the next name on GitLab when another project holds oxagen-<slug>", async () => {
    const lab = gitlabFake();
    const foreign = lab.seedProject({
      name: "oxagen-support",
      description: "Another team's project.",
    });
    const h = new Harness(null, lab);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.state(WS)).toMatchObject({
      attempt: 2,
      candidate: "oxagen-support-2",
      repository: {
        id: foreign + 1,
        owner: ORG,
        name: "oxagen-support-2",
        full_name: "acme/oxagen-support-2",
      },
    });
    const { projects } = lab.snapshot();
    expect(projects["acme/oxagen-support"]?.description).toBe(
      "Another team's project.",
    );
    expect(projects["acme/oxagen-support-2"]?.description).toBe(
      WORKSPACE_DESCRIPTION,
    );
  });

  it("adopts a GitLab project that carries this workspace's marker", async () => {
    const clean = await cleanGitlabRun(WS);
    const lab = gitlabFake();
    const seeded = lab.seedProject({
      name: "oxagen-support",
      description: WORKSPACE_DESCRIPTION,
    });
    const h = new Harness(null, lab);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.state(WS)?.repository).toEqual({
      ...GITLAB_REPOSITORY,
      id: seeded,
    });
    expect(lab.snapshot()).toEqual(clean.snapshot);
  });
});

// ── Rerun convergence ────────────────────────────────────────────────────────

describe("a rerun after one failure", () => {
  const GITHUB_FAULTS: {
    step: SteeringRepoStep;
    inject: (hub: FakeGithub, h: Harness) => void;
  }[] = [
    {
      step: "pick_connection",
      inject: (hub) =>
        hub.failNext({ method: "GET", path: "/user/installations", status: 500 }),
    },
    {
      step: "create_repository",
      inject: (hub) =>
        hub.failNext({ method: "POST", path: "/orgs/acme/repos", status: 500 }),
    },
    {
      step: "add_to_installation",
      inject: (hub) =>
        hub.failNext({
          method: "PUT",
          path: "/user/installations/77/repositories/",
          status: 500,
        }),
    },
    {
      step: "write_first_commit",
      inject: (hub) =>
        hub.failNext({
          method: "PATCH",
          path: "/git/refs/heads/main",
          status: 500,
        }),
    },
    {
      step: "apply_settings",
      inject: (hub) =>
        hub.failNext({ method: "POST", path: "/rulesets", status: 500 }),
    },
    {
      step: "publish_version",
      inject: (hub) =>
        hub.failNext({ method: "POST", path: /\/deployments$/, status: 500 }),
    },
    {
      step: "bind_repository",
      inject: (_hub, h) => {
        h.faults.bind = 1;
      },
    },
  ];

  it.each(GITHUB_FAULTS)(
    "converges on GitHub after $step fails once",
    async ({ step, inject }) => {
      const clean = await cleanGithubRun(WS);
      const hub = githubFake();
      const h = new Harness(hub, null);
      inject(hub, h);

      const err = await runUntilStopped(h.deps(), WS);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SteeringProvisionBlockedError);
      expect(h.state(WS)).toMatchObject({
        status: "failed",
        failed_step: step,
        error: { code: "step_failed" },
      });

      expect(await runUntilStopped(h.deps(), WS, step)).toBeNull();
      expect(hub.snapshot()).toEqual(clean.snapshot);
      expect(h.state(WS)).toEqual(clean.state);
      expect(h.notified).toEqual([]);
    },
  );

  const GITLAB_FAULTS: {
    label: string;
    step: SteeringRepoStep;
    inject: (lab: FakeGitlab, h: Harness) => void;
  }[] = [
    {
      label: "the group list",
      step: "pick_connection",
      inject: (_lab, h) => {
        h.faults.groups = 1;
      },
    },
    {
      label: "the project create before GitLab applies it",
      step: "create_repository",
      inject: (lab) =>
        lab.failNext({ method: "POST", path: "/projects", status: 500 }),
    },
    {
      label: "the project create after GitLab applies it",
      step: "create_repository",
      inject: (lab) =>
        lab.failNext({
          method: "POST",
          path: "/projects",
          status: 500,
          after: true,
        }),
    },
    {
      label: "the first commit",
      step: "write_first_commit",
      inject: (lab) =>
        lab.failNext({
          method: "POST",
          path: "/projects/1/repository/commits",
          status: 500,
        }),
    },
    {
      label: "the project settings update",
      step: "apply_settings",
      inject: (lab) =>
        lab.failNext({ method: "PUT", path: "/projects/1", status: 500 }),
    },
    {
      label: "the approval settings update",
      step: "apply_settings",
      inject: (lab) =>
        lab.failNext({ method: "POST", path: "/projects/1/approvals", status: 500 }),
    },
    {
      label: "the hook create before GitLab applies it",
      step: "register_webhook",
      inject: (lab) =>
        lab.failNext({ method: "POST", path: "/projects/1/hooks", status: 500 }),
    },
    {
      label: "the hook create after GitLab applies it",
      step: "register_webhook",
      inject: (lab) =>
        lab.failNext({
          method: "POST",
          path: "/projects/1/hooks",
          status: 500,
          after: true,
        }),
    },
    {
      label: "the deployment before GitLab records it",
      step: "publish_version",
      inject: (lab) =>
        lab.failNext({
          method: "POST",
          path: "/projects/1/deployments",
          status: 500,
        }),
    },
    {
      label: "the deployment after GitLab records it",
      step: "publish_version",
      inject: (lab) =>
        lab.failNext({
          method: "POST",
          path: "/projects/1/deployments",
          status: 500,
          after: true,
        }),
    },
    {
      label: "the binding write",
      step: "bind_repository",
      inject: (_lab, h) => {
        h.faults.bind = 1;
      },
    },
  ];

  it.each(GITLAB_FAULTS)(
    "converges on GitLab after $label fails once at $step",
    async ({ step, inject }) => {
      const clean = await cleanGitlabRun(WS);
      const lab = gitlabFake();
      const h = new Harness(null, lab);
      inject(lab, h);

      const err = await runUntilStopped(h.deps(), WS);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SteeringProvisionBlockedError);
      expect(h.state(WS)).toMatchObject({
        status: "failed",
        failed_step: step,
        error: { code: "step_failed" },
      });

      expect(await runUntilStopped(h.deps(), WS, step)).toBeNull();
      expect(lab.snapshot()).toEqual(clean.snapshot);
      expect(h.state(WS)).toEqual(clean.state);
      expect(h.notified).toEqual([]);
    },
  );
});
