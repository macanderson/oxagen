// steering_repo.provision.test.ts: the steering repo provisioning steps, run
// against the in-memory GitHub and GitLab fakes (lane S1, #4450).
//
// The dependencies live in memory: state and connection per scope in maps,
// with every save, bind, and re-authorize banner recorded. The real
// dependency factory has its own test in steering_repo.provision.deps.test.ts.
import * as gh from "@oxagen/github/provision";
import {
  FAKE_USER_LOGIN,
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
  pickSteeringConnection,
  planConnectionReset,
  releasedSteeringRepoState,
  REPOSITORY_CREATE_REFUSED,
  RESET_RUNNING_MS,
  repositoryOnConnection,
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
import type { LegacySteeringSource } from "./steering-repo/legacy-source";

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
  account_type: "Organization",
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
  /** Every connection keepConnection was asked to store, stored or not. */
  readonly keptConnections: SteeringConnection[] = [];
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
  /** Every workspace the bind step published a first version for (#4732). */
  readonly firstPublishes: { orgId: string; workspaceId: string }[] = [];
  /** The version store holds the first commit as version 1. */
  storeHoldsFirst = false;
  /**
   * How many more times each dependency fails. `stale` makes the first
   * publish answer that the production branch moved.
   */
  readonly faults = { bind: 0, groups: 0, stale: 0 };
  userToken = true;
  groupToken = true;
  /** GitLab refuses the stored group token while the groups are listed. */
  groupsRefused = false;
  githubConfigured = true;
  workspaceGone = false;
  /** The workspace the job provisions for. A test names another slug. */
  workspaceTarget: ProvisionTarget = WORKSPACE_TARGET;
  /** The code repository that still steers the workspace, if any. */
  legacy: LegacySteeringSource | null = null;
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
        // As the production load does: a workspace's own connection comes
        // before the organization's.
        const connection =
          state?.connection ?? this.connections.get(scope.orgId) ?? null;
        return Promise.resolve({
          target:
            scope.kind === "workspace" ? this.workspaceTarget : ORG_TARGET,
          state: state === undefined ? null : structuredClone(state),
          connection: connection === null ? null : structuredClone(connection),
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
      // Set-if-absent, as keepSteeringConnection is.
      keepConnection: (scope, connection) => {
        this.keptConnections.push(structuredClone(connection));
        if (!this.connections.has(scope.orgId))
          this.connections.set(scope.orgId, structuredClone(connection));
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
      legacySteeringSource: () => Promise.resolve(this.legacy),
      // The version store answers `published` for the first head it sees and
      // `current` after that, as steeringSyncPublish does.
      publishFirst: (scope) => {
        this.firstPublishes.push({ ...scope });
        if (this.faults.stale > 0) {
          this.faults.stale -= 1;
          return Promise.resolve({ status: "stale", version: null });
        }
        const status = this.storeHoldsFirst ? "current" : "published";
        this.storeHoldsFirst = true;
        return Promise.resolve({ status, version: 1 });
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
      connection_choices: [],
      requested_name: null,
      requested_connection: null,
      connection: null,
      updated_at: "2026-09-26T12:00:00.000Z",
    });
  });

  it("carries what a person chose for the name and the place, and resolves no place", () => {
    expect(
      initialSteeringRepoState(NOW, {
        name: "acme-support",
        connection: { provider: "gitlab", id: 42 },
      }),
    ).toMatchObject({
      status: "provisioning",
      attempt: 1,
      requested_name: "acme-support",
      requested_connection: { provider: "gitlab", id: 42 },
      connection: null,
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

  it("keeps a workspace's own valid connection and drops a malformed one", () => {
    expect(
      readSteeringRepoState({
        steering_repo: { status: "provisioning", connection: GITLAB_CONNECTION },
      })?.connection,
    ).toEqual(GITLAB_CONNECTION);
    expect(
      readSteeringRepoState({
        steering_repo: {
          status: "provisioning",
          connection: { provider: "github", installation_id: "77" },
        },
      })?.connection,
    ).toBeNull();
    expect(
      readSteeringRepoState({
        steering_repo: { status: "provisioning", connection: "acme" },
      })?.connection,
    ).toBeNull();
  });

  it("keeps what a person chose across a read", () => {
    expect(
      readSteeringRepoState({
        steering_repo: {
          status: "blocked",
          requested_name: "acme-support",
          requested_connection: { provider: "github", id: 77 },
        },
      }),
    ).toMatchObject({
      requested_name: "acme-support",
      requested_connection: { provider: "github", id: 77 },
      connection: null,
    });
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
      rulesets: [],
      environments: {},
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
      connection_choices: [],
      requested_name: null,
      requested_connection: null,
      connection: null,
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
          rulesets: [],
          environments: {
            steering: {
              deployment_branch_policy: null,
              branch_policies: [],
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
      connection_choices: [],
      requested_name: null,
      requested_connection: null,
      connection: null,
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
  it("creates <org>/oxagen-config with no workspace.toml and binds nothing", async () => {
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
    const repo = githubRepo(hub, "oxagen-config");
    expect(repo?.description).toBe(ORG_DESCRIPTION);
    const files = seedFilesOf("github", "acme/oxagen-config", false);
    expect(files["workspace.toml"]).toBeUndefined();
    expect(repo?.files).toEqual({ main: files });
    expect(h.binds).toEqual([]);
    expect(h.state(ORG_SCOPE)).toMatchObject({
      status: "ready",
      step: "publish_version",
      repository: { name: "oxagen-config", full_name: "acme/oxagen-config" },
      binding_id: null,
    });
    expect(h.state(WS)).toBeUndefined();
  });

  it("returns ready from a full run", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), ORG_SCOPE)).toBe("ready");
    expect(h.binds).toEqual([]);
    // An organization repo has no workspace, so no version store to publish to.
    expect(h.firstPublishes).toEqual([]);
  });

  it("stops when another repository already holds the one name it may use", async () => {
    const hub = githubFake();
    hub.seedRepository({ name: "oxagen-config", description: "Someone else's." });
    const h = new Harness(hub, null);
    const err = await runUntilStopped(h.deps(), ORG_SCOPE);
    expect(err).toBeInstanceOf(SteeringProvisionBlockedError);
    expect(err).toMatchObject({ code: "repository_name_taken" });
    expect((err as Error).message).toContain(
      "Every name from oxagen-config to oxagen-config is taken in acme.",
    );
    expect(h.state(ORG_SCOPE)).toMatchObject({
      status: "blocked",
      failed_step: "create_repository",
      error: { code: "repository_name_taken" },
      repository: null,
    });
    expect(h.notified).toEqual([]);
  });

  it("starts the config workspace at oxagen-config-2, beside the organization's repo", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    h.workspaceTarget = {
      org_slug: WORKSPACE_TARGET.org_slug,
      workspace: { slug: "config", name: "Config" },
    };
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    await runSteeringRepoStep(h.deps(), WS, "create_repository");
    expect(githubRepo(hub, "oxagen-config")).toBeUndefined();
    expect(githubRepo(hub, "oxagen-config-2")).toBeDefined();
    expect(h.state(WS)).toMatchObject({
      attempt: 2,
      repository: { name: "oxagen-config-2" },
    });
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
        "This organization has no GitHub organization with the Oxagen GitHub App installed and no GitLab group token. Connect one, then retry.",
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
    // The blocked state lists both, so a person can pick one (#4875).
    expect(h.state(WS)?.connection_choices).toHaveLength(2);
    expect(h.savedConnections).toEqual([]);
  });

  it("records the choices a person picks from, and only those can be picked", async () => {
    const h = new Harness(githubFake(), gitlabFake());
    await stepError(h.deps(), WS, "pick_connection");
    const state = h.state(WS) ?? null;
    expect(state?.connection_choices).toEqual([
      expect.objectContaining({ provider: "github" }),
      expect.objectContaining({ provider: "gitlab", group_id: 42 }),
    ]);
    expect(
      pickSteeringConnection(state, { provider: "gitlab", id: 42 }),
    ).toEqual(GITLAB_CONNECTION);
    expect(pickSteeringConnection(state, { provider: "github", id: 42 })).toBeNull();
    expect(pickSteeringConnection(null, { provider: "gitlab", id: 42 })).toBeNull();
  });

  it("clears the recorded choices once a connection is stored", async () => {
    const h = new Harness(githubFake(), gitlabFake());
    await stepError(h.deps(), WS, "pick_connection");
    h.connections.set("org_1", GITLAB_CONNECTION);
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    expect(h.state(WS)).toMatchObject({
      provider: "gitlab",
      connection_choices: [],
    });
  });

  it("blocks with steering_import_required before anything is made while a code repository steers the workspace", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    h.legacy = { provider: "github", full_name: "acme/agent-harness" };
    h.connections.set("org_1", GITHUB_CONNECTION);
    const err = await stepError(h.deps(), WS, "pick_connection");
    expect(err).toMatchObject({
      code: "steering_import_required",
      isNonRetriable: true,
    });
    expect((err as Error).message).toContain("acme/agent-harness");
    expect(h.state(WS)).toMatchObject({
      status: "blocked",
      step: null,
      failed_step: "pick_connection",
      error: { code: "steering_import_required" },
    });
    expect(hub.calls).toEqual([]);
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

// ── A workspace's own choice ─────────────────────────────────────────────────

/** A workspace whose create named a place, a name, or both. */
function chose(
  h: Harness,
  request: Parameters<typeof initialSteeringRepoState>[1],
): void {
  h.states.set(keyOf(WS), initialSteeringRepoState(NOW, request));
}

describe("a workspace that chose its place", () => {
  it("creates the repository on the GitLab group it chose, though the organization stores a GitHub organization", async () => {
    const hub = githubFake();
    const lab = gitlabFake();
    const h = new Harness(hub, lab);
    h.connections.set("org_1", GITHUB_CONNECTION);
    chose(h, { connection: { provider: "gitlab", id: GROUP.id } });

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");

    expect(h.state(WS)).toMatchObject({
      status: "ready",
      provider: "gitlab",
      requested_connection: { provider: "gitlab", id: GROUP.id },
      connection: GITLAB_CONNECTION,
      repository: GITLAB_REPOSITORY,
    });
    expect(lab.snapshot().projects["acme/oxagen-support"]?.description).toBe(
      WORKSPACE_DESCRIPTION,
    );
    // Nothing reached the organization's GitHub organization.
    expect(githubRepo(hub, "oxagen-support")).toBeUndefined();
    expect(hub.writes()).toEqual([]);
    expect(h.binds).toEqual([
      {
        scope: WS,
        connection: GITLAB_CONNECTION,
        repository: GITLAB_REPOSITORY,
        default_branch: "main",
      },
    ]);
    // The organization keeps its own stored connection.
    expect(h.connections.get("org_1")).toEqual(GITHUB_CONNECTION);
    expect(h.keptConnections).toEqual([GITLAB_CONNECTION]);
    expect(h.savedConnections).toEqual([]);
  });

  it("creates the repository on the GitHub organization it chose, though the organization stores a GitLab group", async () => {
    const hub = githubFake();
    const lab = gitlabFake();
    const h = new Harness(hub, lab);
    h.connections.set("org_1", GITLAB_CONNECTION);
    chose(h, { connection: { provider: "github", id: 77 } });

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");

    expect(h.state(WS)).toMatchObject({
      provider: "github",
      connection: GITHUB_CONNECTION,
      repository: GITHUB_REPOSITORY,
    });
    expect(githubRepo(hub, "oxagen-support")?.description).toBe(
      WORKSPACE_DESCRIPTION,
    );
    expect(Object.keys(lab.snapshot().projects)).toEqual([]);
    expect(h.connections.get("org_1")).toEqual(GITLAB_CONNECTION);
  });

  it("settles two places without a choose_connection stop, and makes the choice the organization's default", async () => {
    const h = new Harness(githubFake(), gitlabFake());
    chose(h, { connection: { provider: "gitlab", id: GROUP.id } });

    expect(await runSteeringRepoStep(h.deps(), WS, "pick_connection")).toEqual(
      { step: "pick_connection", status: "provisioning", ran: true },
    );
    expect(h.state(WS)).toMatchObject({
      status: "provisioning",
      provider: "gitlab",
      connection: GITLAB_CONNECTION,
      connection_choices: [],
      error: null,
    });
    expect(h.connections.get("org_1")).toEqual(GITLAB_CONNECTION);
    expect(h.keptConnections).toEqual([GITLAB_CONNECTION]);
    // The unconditional store is for a lone candidate, not a choice.
    expect(h.savedConnections).toEqual([]);
  });

  it("does not list the hosts again once the choice is resolved", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    chose(h, { connection: { provider: "github", id: 77 } });
    const listings = () =>
      hub.calls.filter((c) => c.path.startsWith("/user/installations")).length;

    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    expect(listings()).toBe(1);
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    expect(listings()).toBe(1);
    expect(h.keptConnections).toEqual([GITHUB_CONNECTION]);
    expect(h.state(WS)?.connection).toEqual(GITHUB_CONNECTION);
  });

  it("blocks with unknown_connection before anything is made when the stored tokens do not reach the choice", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    // The organization's own connection would work. The job must not fall
    // back to it.
    h.connections.set("org_1", GITHUB_CONNECTION);
    chose(h, { connection: { provider: "github", id: 999 } });

    const err = await runUntilStopped(h.deps(), WS);

    expect(err).toBeInstanceOf(SteeringProvisionBlockedError);
    expect(err).toMatchObject({
      code: "unknown_connection",
      isNonRetriable: true,
    });
    expect((err as Error).message).toContain("github 999");
    expect(h.state(WS)).toMatchObject({
      status: "blocked",
      step: null,
      failed_step: "pick_connection",
      error: { code: "unknown_connection" },
      connection: null,
      repository: null,
    });
    expect(hub.writes()).toEqual([]);
    expect(h.keptConnections).toEqual([]);
    expect(h.binds).toEqual([]);
  });

  it("leaves the organization repo on the organization's connection", async () => {
    const hub = githubFake();
    const lab = gitlabFake();
    const h = new Harness(hub, lab);
    h.connections.set("org_1", GITHUB_CONNECTION);
    h.states.set(
      keyOf(ORG_SCOPE),
      initialSteeringRepoState(NOW, {
        name: "custom-config",
        connection: { provider: "gitlab", id: GROUP.id },
      }),
    );

    expect(await provisionSteeringRepo(h.deps(), ORG_SCOPE)).toBe("ready");

    expect(h.state(ORG_SCOPE)).toMatchObject({
      provider: "github",
      connection: null,
      repository: { name: "oxagen-config", full_name: "acme/oxagen-config" },
    });
    expect(Object.keys(lab.snapshot().projects)).toEqual([]);
    expect(h.keptConnections).toEqual([]);
  });
});

describe("a workspace that chose its name", () => {
  const NAME = "acme-support-rules";
  const TAKEN = `acme already has a repository named ${NAME} that Oxagen did not create for this workspace. Choose another name, then retry.`;

  it("creates exactly that name on GitHub, on one attempt", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    chose(h, { name: NAME });

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");

    expect(h.state(WS)).toMatchObject({
      attempt: 1,
      candidate: NAME,
      repository: { owner: ORG, name: NAME, full_name: `acme/${NAME}` },
    });
    expect(githubRepo(hub, NAME)?.description).toBe(WORKSPACE_DESCRIPTION);
    expect(githubRepo(hub, "oxagen-support")).toBeUndefined();
  });

  it("starts the chosen name at its first attempt, whatever an earlier run counted", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    h.states.set(keyOf(WS), {
      ...initialSteeringRepoState(NOW, { name: NAME }),
      attempt: 5,
    });

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.state(WS)).toMatchObject({ attempt: 1, candidate: NAME });
    expect(githubRepo(hub, `${NAME}-5`)).toBeUndefined();
  });

  it("stops with repository_name_taken on GitHub and takes no -2", async () => {
    const hub = githubFake();
    hub.seedRepository({ name: NAME, description: "Another team's repository." });
    const h = new Harness(hub, null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    chose(h, { name: NAME });

    const err = await runUntilStopped(h.deps(), WS);

    expect(err).toBeInstanceOf(SteeringProvisionBlockedError);
    expect(err).toMatchObject({ code: "repository_name_taken", message: TAKEN });
    expect(h.state(WS)).toMatchObject({
      status: "blocked",
      failed_step: "create_repository",
      error: { code: "repository_name_taken", message: TAKEN },
      repository: null,
    });
    expect(
      hub.writes().filter((c) => c.method === "POST" && c.path === "/orgs/acme/repos"),
    ).toHaveLength(1);
    expect(githubRepo(hub, `${NAME}-2`)).toBeUndefined();
  });

  it("stops with repository_name_taken on GitLab and takes no -2", async () => {
    const lab = gitlabFake();
    lab.seedProject({ name: NAME, description: "Another team's project." });
    const h = new Harness(null, lab);
    h.connections.set("org_1", GITLAB_CONNECTION);
    chose(h, { name: NAME });

    const err = await runUntilStopped(h.deps(), WS);

    expect(err).toMatchObject({ code: "repository_name_taken", message: TAKEN });
    expect(lab.snapshot().projects[`acme/${NAME}-2`]).toBeUndefined();
  });

  it("adopts the chosen name when its repository carries this workspace's marker", async () => {
    const hub = githubFake();
    const seeded = hub.seedRepository({
      name: NAME,
      description: WORKSPACE_DESCRIPTION,
    });
    const h = new Harness(hub, null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    chose(h, { name: NAME });

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.state(WS)?.repository).toMatchObject({ id: seeded, name: NAME });
  });

  it("puts the chosen name in the chosen place", async () => {
    const hub = githubFake();
    const lab = gitlabFake();
    const h = new Harness(hub, lab);
    h.connections.set("org_1", GITHUB_CONNECTION);
    chose(h, { name: NAME, connection: { provider: "gitlab", id: GROUP.id } });

    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.state(WS)?.repository).toMatchObject({
      owner: ORG,
      name: NAME,
      full_name: `acme/${NAME}`,
    });
    expect(lab.snapshot().projects[`acme/${NAME}`]).toBeDefined();
    expect(githubRepo(hub, NAME)).toBeUndefined();
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
      "No organization owner has authorized the Oxagen GitHub App for steering. An owner must authorize it.",
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
      "The stored steering authorization cannot reach the Oxagen GitHub App installation on acme. An owner must authorize it again.",
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
  it("blocks without a banner when the Oxagen GitHub App is not configured", async () => {
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
        hub.failNext({ method: "PUT", path: "/actions/permissions", status: 500 }),
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

// ── The first steering version ───────────────────────────────────────────────

describe("the first steering version (#4732)", () => {
  it("publishes the first commit through the version store once the workspace is bound", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    const deps = h.deps();
    for (const step of STEERING_REPO_STEPS.slice(0, -1))
      await runSteeringRepoStep(deps, WS, step);
    // publish_version records the host deployment only.
    expect(h.firstPublishes).toEqual([]);

    expect(await runSteeringRepoStep(deps, WS, "bind_repository")).toEqual({
      step: "bind_repository",
      status: "ready",
      ran: true,
    });
    expect(h.binds).toHaveLength(1);
    expect(h.firstPublishes).toEqual([{ orgId: "org_1", workspaceId: "ws_1" }]);
    expect(h.storeHoldsFirst).toBe(true);
  });

  it("answers current on a second run, so the store keeps one version for the first commit", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
    expect(h.firstPublishes).toHaveLength(2);
    expect(h.state(WS)).toMatchObject({ status: "ready", error: null });
  });

  it("fails bind_repository when the branch moved during the publish, and a rerun converges", async () => {
    const clean = await cleanGithubRun(WS);
    const hub = githubFake();
    const h = new Harness(hub, null);
    h.faults.stale = 1;

    const err = await runUntilStopped(h.deps(), WS);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SteeringProvisionBlockedError);
    expect((err as Error).message).toMatch(/acme\/oxagen-support moved/);
    expect(h.state(WS)).toMatchObject({
      status: "failed",
      failed_step: "bind_repository",
      error: { code: "step_failed" },
    });
    expect(h.storeHoldsFirst).toBe(false);

    expect(await runUntilStopped(h.deps(), WS, "bind_repository")).toBeNull();
    expect(h.state(WS)).toEqual(clean.state);
    expect(hub.snapshot()).toEqual(clean.snapshot);
    expect(h.firstPublishes).toHaveLength(2);
    expect(h.storeHoldsFirst).toBe(true);
  });

  it("finishes the step when no version store is wired", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    const { publishFirst: _unused, ...deps } = h.deps();
    expect(await provisionSteeringRepo(deps, WS)).toBe("ready");
    expect(h.firstPublishes).toEqual([]);
  });
});

// ── Personal accounts and refused creates (#4899) ────────────────────────────

describe("a personal GitHub account", () => {
  const personalFake = () =>
    new FakeGithub({
      org: FAKE_USER_LOGIN,
      app: APP,
      user_installations: [
        {
          id: 78,
          account_login: FAKE_USER_LOGIN,
          account_type: "User",
          repository_selection: "selected",
        },
      ],
    });
  const PERSONAL: SteeringConnection = {
    provider: "github",
    installation_id: 78,
    account_login: FAKE_USER_LOGIN,
    account_type: "User",
  };

  it("is a candidate when it is the owner's own account", async () => {
    const h = new Harness(personalFake(), null);
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    expect(h.savedConnections).toEqual([PERSONAL]);
  });

  it("is skipped when it belongs to someone else (negative)", async () => {
    const hub = githubFake({
      user_installations: [
        {
          id: 79,
          account_login: "someone-else",
          account_type: "User",
          repository_selection: "selected",
        },
      ],
    });
    const h = new Harness(hub, null);
    const err = await stepError(h.deps(), WS, "pick_connection");
    expect(err).toMatchObject({ code: "no_connection" });
    expect(h.savedConnections).toEqual([]);
  });

  it("gets its repository from the owner's token on /user/repos", async () => {
    const hub = personalFake();
    const h = new Harness(hub, null);
    h.connections.set("org_1", PERSONAL);
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    await runSteeringRepoStep(h.deps(), WS, "create_repository");
    expect(githubRepo(hub, "oxagen-support")).toBeDefined();
    expect(h.state(WS)?.repository).toMatchObject({
      owner: FAKE_USER_LOGIN,
      name: "oxagen-support",
    });
  });

  it("asks the owner to authorize again when no owner token is stored", async () => {
    const h = new Harness(personalFake(), null);
    h.connections.set("org_1", PERSONAL);
    h.userToken = false;
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    const err = await stepError(h.deps(), WS, "create_repository");
    expect(err).toMatchObject({ code: REAUTHORIZE });
  });
});

describe("a refused create", () => {
  it("stops with repository_create_refused and GitHub's message, not a taken name", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    hub.failNext({
      method: "POST",
      path: "/orgs/acme/repos",
      status: 422,
      message:
        "Due to policy, you are not permitted to perform that operation on this repository.",
    });
    const err = await stepError(h.deps(), WS, "create_repository");
    expect(err).toMatchObject({
      code: REPOSITORY_CREATE_REFUSED,
      isNonRetriable: true,
    });
    expect((err as Error).message).toContain("GitHub refused to create a repository in acme");
    expect((err as Error).message).toContain("Due to policy");
    // A repository policy that restricts creations is the usual cause, so the
    // message names the fix (#4899).
    expect((err as Error).message).toContain(
      "add the Oxagen app to its allow list",
    );
    expect(h.state(WS)).toMatchObject({
      status: "blocked",
      failed_step: "create_repository",
      error: { code: REPOSITORY_CREATE_REFUSED },
    });
  });

  it("leaves a rate limit to the job's retry", async () => {
    const hub = githubFake();
    const h = new Harness(hub, null);
    h.connections.set("org_1", GITHUB_CONNECTION);
    await runSteeringRepoStep(h.deps(), WS, "pick_connection");
    hub.failNext({
      method: "POST",
      path: "/orgs/acme/repos",
      status: 403,
      message: "API rate limit exceeded for installation.",
    });
    const err = await stepError(h.deps(), WS, "create_repository");
    expect(err).not.toBeInstanceOf(SteeringProvisionBlockedError);
    expect(h.state(WS)).toMatchObject({ status: "failed" });
  });

  it("still reads every name taken as repository_name_taken", async () => {
    const hub = githubFake();
    for (let n = 1; n <= 20; n++)
      hub.seedRepository({
        name: n === 1 ? "oxagen-support" : `oxagen-support-${n}`,
        description: "Someone else's.",
      });
    const h = new Harness(hub, null);
    const err = await runUntilStopped(h.deps(), WS);
    expect(err).toMatchObject({ code: "repository_name_taken" });
  });
});

describe("GitHub Free steering repositories", () => {
  it.each(["Organization", "User"] as const)(
    "provisions a private repository for a free %s without paid settings",
    async (accountType) => {
      const account = accountType === "User" ? FAKE_USER_LOGIN : ORG;
      const hub = new FakeGithub({
        org: account,
        app: APP,
        user_installations: [
          {
            id: 77,
            account_login: account,
            account_type: accountType,
            repository_selection: "selected",
          },
        ],
      });
      hub.failNext({
        path: /\/(?:rulesets|environments)(?:[/?]|$)/,
        status: 403,
        message: "Upgrade your GitHub plan to use this feature.",
      });
      const h = new Harness(hub, null);
      h.connections.set("org_1", {
        provider: "github",
        installation_id: 77,
        account_login: account,
        account_type: accountType,
      });

      expect(await provisionSteeringRepo(h.deps(), WS)).toBe("ready");
      expect(githubRepo(hub, "oxagen-support")).toMatchObject({
        private: true,
        rulesets: [],
        merge: GITHUB_SETTINGS_BASELINE.merge,
        actions_enabled: false,
        deployments: [
          expect.objectContaining({
            latest_status: "success",
            payload: { version: 1 },
          }),
        ],
      });
      expect(
        hub.calls.some((call) => /\/(?:rulesets|environments)(?:[/?]|$)/.test(call.path)),
      ).toBe(false);
      expect(h.binds).toHaveLength(1);
    },
  );

  it("surfaces a refused ordinary settings write", async () => {
    const hub = githubFake();
    hub.failNext({
      method: "PUT",
      path: "/actions/permissions",
      status: 403,
      message: "Resource not accessible by integration",
    });
    const h = new Harness(hub, null);

    const err = await runUntilStopped(h.deps(), WS);

    expect(err).toMatchObject({ status: 403 });
    expect(err).not.toBeInstanceOf(SteeringProvisionBlockedError);
    expect(h.state(WS)).toMatchObject({
      status: "failed",
      failed_step: "apply_settings",
    });
    expect(h.binds).toEqual([]);
  });
});

describe("repositoryOnConnection", () => {
  const repo = (owner: string): SteeringRepository => ({
    id: 1,
    owner,
    name: "oxagen-support",
    full_name: `${owner}/oxagen-support`,
    initial_branch: "main",
  });
  const state = (
    provider: "github" | "gitlab",
    owner: string | null,
  ): SteeringRepoState => ({
    ...initialSteeringRepoState(NOW),
    provider,
    repository: owner === null ? null : repo(owner),
  });

  it("finds a repository a setup made in the connected account", () => {
    expect(
      repositoryOnConnection(GITHUB_CONNECTION, [
        null,
        state("github", null),
        state("github", "ACME"),
      ]),
    ).toMatchObject({ full_name: "ACME/oxagen-support" });
    expect(
      repositoryOnConnection(GITLAB_CONNECTION, [state("gitlab", `${ORG}/steering`)]),
    ).toMatchObject({ owner: `${ORG}/steering` });
  });

  it("finds none in another account or on another host (negative)", () => {
    expect(
      repositoryOnConnection(GITHUB_CONNECTION, [
        state("github", "acme-old"),
        state("gitlab", ORG),
      ]),
    ).toBeNull();
    expect(
      repositoryOnConnection(GITLAB_CONNECTION, [state("gitlab", `${ORG}x`)]),
    ).toBeNull();
  });
});

describe("planConnectionReset", () => {
  const made = (owner: string): SteeringRepository => ({
    id: 1,
    owner,
    name: "oxagen-support",
    full_name: `${owner}/oxagen-support`,
    initial_branch: "main",
  });
  const at = (overrides: Partial<SteeringRepoState>): SteeringRepoState => ({
    ...initialSteeringRepoState(new Date(NOW.getTime() - RESET_RUNNING_MS - 1)),
    provider: "github",
    status: "blocked",
    ...overrides,
  });

  it("waits for a setup that saved as provisioning within the window", () => {
    expect(
      planConnectionReset(
        GITHUB_CONNECTION,
        [{ key: "ws_1", state: at({ status: "provisioning", updated_at: NOW.toISOString() }) }],
        NOW,
      ),
    ).toEqual({ kind: "refuse", reason: "setup_running" });
  });

  it("treats an old provisioning state that never saved again as stopped", () => {
    expect(
      planConnectionReset(
        GITHUB_CONNECTION,
        [{ key: "ws_1", state: at({ status: "provisioning" }) }],
        NOW,
      ),
    ).toEqual({ kind: "clear", release: [] });
  });

  it("refuses once a repo in the stored account published, bound, or finished", () => {
    for (const pinned of [
      { deployment_id: 9 },
      { binding_id: "rpb_1" },
      { status: "ready" as const },
    ])
      expect(
        planConnectionReset(
          GITHUB_CONNECTION,
          [{ key: "ws_1", state: at({ repository: made(ORG), ...pinned }) }],
          NOW,
        ),
      ).toMatchObject({ kind: "refuse", reason: "connection_in_use" });
  });

  it("neither waits on nor releases a workspace that chose its own connection", () => {
    const own = at({
      connection: GITHUB_CONNECTION,
      repository: made(ORG),
      failed_step: "apply_settings",
    });
    expect(
      planConnectionReset(GITHUB_CONNECTION, [{ key: "ws_1", state: own }], NOW),
    ).toEqual({ kind: "clear", release: [] });
    expect(
      planConnectionReset(
        GITHUB_CONNECTION,
        [
          {
            key: "ws_1",
            state: at({
              connection: GITHUB_CONNECTION,
              status: "provisioning",
              updated_at: NOW.toISOString(),
            }),
          },
        ],
        NOW,
      ),
    ).toEqual({ kind: "clear", release: [] });
    expect(
      planConnectionReset(
        GITHUB_CONNECTION,
        [{ key: "ws_1", state: at({ connection: GITHUB_CONNECTION, repository: made(ORG), status: "ready" }) }],
        NOW,
      ),
    ).toEqual({ kind: "clear", release: [] });
  });

  it("releases a setup that stopped before publishing its repo there", () => {
    expect(
      planConnectionReset(
        GITHUB_CONNECTION,
        [
          { key: null, state: null },
          { key: "ws_1", state: at({ repository: made(ORG), failed_step: "apply_settings" }) },
          { key: "ws_2", state: at({ repository: made("elsewhere"), deployment_id: 3 }) },
        ],
        NOW,
      ),
    ).toEqual({ kind: "clear", release: ["ws_1"] });
    const released = releasedSteeringRepoState(
      at({ repository: made(ORG), step: "write_first_commit", commit_sha: "abc", attempt: 2 }),
      NOW,
    );
    expect(released).toMatchObject({
      status: "blocked",
      step: null,
      repository: null,
      commit_sha: null,
      attempt: 1,
      candidate: null,
    });
  });
});

