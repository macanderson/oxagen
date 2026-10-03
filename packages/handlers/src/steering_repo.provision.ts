// steering_repo.provision.ts: create, seed, and publish a steering repo
// (steering-repo-spec, Provisioning; lane S1, #4450).
//
// Creating a workspace creates its private steering repo `oxagen-<slug>`, and
// creating an organization creates `<org>/oxagen-config`. The durable job
// `steering-repo/provision` runs the steps below one at a time:
//
//   1. pick_connection      The GitHub organization or GitLab group the
//                           workspace chose when it was created, else the
//                           organization's stored one. Oxagen asks only when
//                           neither is set and there is more than one.
//   2. create_repository    The name the workspace chose, exactly. Otherwise
//                           `oxagen-<slug>`, then `-2`, `-3` and so on.
//   3. add_to_installation  GitHub only. The owner's user token adds the new
//                           repository to the installation.
//   4. write_first_commit   S0's templates, committed to main.
//   5. apply_settings       The prescribed settings, read back and compared.
//   6. register_webhook     GitLab only. A project hook that sends push and
//                           merge request events to Oxagen (#4562). A URL
//                           GitLab refuses logs a warning and does not stop
//                           the run.
//   7. publish_version      Version 1, recorded as a deployment to `steering`.
//   8. bind_repository      Workspace only. A binding head with role steering,
//                           then, on GitHub, the steering installation as the
//                           workspace's `github` connection when it has none,
//                           then the first commit published through the
//                           version store as version 1, so the first steering
//                           PR publishes version 2 (#4732).
//
// Once the last step makes a workspace's repo ready, the run starts the move
// of the workspace's MCP servers into it (migrate_tools_to_steering, ADR-245).
// A start that fails is logged, and the repo stays ready.
//
// Every step is safe to repeat. The state lives in the `steering_repo` key of
// the workspace's settings, or of the organization's for `<org>/oxagen-config`, and
// records what each step made, so a rerun adopts it instead of making another.
// A failed step records its name and error, and the job retries from it.
//
// Two stops wait on a person (#4875). A workspace still steered by the
// `.oxagen/` tree of a code repository stops at pick_connection with
// `steering_import_required`, before anything is created, because the bind
// step would refuse a second steering head. import_workspace_steering moves
// that steering and provisions in the same run. An organization whose owner
// token reaches more than one GitHub organization or GitLab group stops with
// `choose_connection` and records the candidates, and a retry or an import
// that names one of them stores it (`pickSteeringConnection`,
// `storeChosenSteeringConnection`). The organization has one connection, so
// the first pick stands and a later, different pick is refused.
import { decrypt, resolveIngestionCryptoAdapterForKeyId } from "@oxagen/crypto";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import {
  createAppInstallationToken,
  GitHubApiError,
  GitHubRateLimitedError,
} from "@oxagen/github";
import * as gh from "@oxagen/github/provision";
import * as gl from "@oxagen/gitlab/provision";
import {
  firstCommitFiles,
  GITHUB_SETTINGS_BASELINE,
  GITLAB_SETTINGS_BASELINE,
  ORGANIZATION_REPO_NAME,
  OXAGEN_STEERING_APP,
  STEERING_DEFAULT_BRANCH,
  STEERING_ENVIRONMENT,
  steeringRepoName,
} from "@oxagen/oxagen/steering-repo";
import { HandlerError } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  GITHUB_STEERING_PROVIDER,
  GITLAB_STEERING_PROVIDER,
  STEERING_APP_UNCONFIGURED_MESSAGE,
  steeringAppFromEnv,
} from "./lib/steering-app";
import {
  steeringHookTarget,
  type SteeringHookTarget,
} from "./lib/steering-hook";
import type { SyncPublish } from "./context.steering.sync";
import { logger } from "./logger";
import { publishFirstVersion } from "./steering-repo/first-version";
import {
  readLegacySteeringSource,
  type LegacySteeringSource,
} from "./steering-repo/legacy-source";
import {
  workspaceRepositoriesLock,
  writeRepositoryHead,
} from "./repository.binding-write";
import {
  attachWorkspaceGithubInstallation,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";

// ── Names ────────────────────────────────────────────────────────────────────

/** The event that starts or retries provisioning. */
export const STEERING_REPO_PROVISION_EVENT =
  "steering-repo/provision.requested";

/** The key in `workspaces.settings` and `organizations.settings`. */
export const STEERING_REPO_SETTING = "steering_repo";

/** The key in `organizations.settings` that names the chosen connection. */
export const STEERING_CONNECTION_SETTING = "steering_connection";

// The provider names and the app's settings live in `lib/steering-app.ts`, so
// the readers that open a steering head can share them without importing this
// module. They are re-exported here for this module's callers.
export {
  GITHUB_STEERING_PROVIDER,
  GITLAB_STEERING_PROVIDER,
  steeringAppFromEnv,
};

/** The steps, in the order the job runs them. */
export const STEERING_REPO_STEPS = [
  "pick_connection",
  "create_repository",
  "add_to_installation",
  "write_first_commit",
  "apply_settings",
  "register_webhook",
  "publish_version",
  "bind_repository",
] as const;
export type SteeringRepoStep = (typeof STEERING_REPO_STEPS)[number];

/** Whether `name` is one of the steps. */
export function isSteeringRepoStep(name: string): name is SteeringRepoStep {
  return (STEERING_REPO_STEPS as readonly string[]).includes(name);
}

/** The error code of a step that needs an owner to authorize again. */
export const REAUTHORIZE = "steering_reauthorize";

/** The error code of a setup that waits on a person to pick its connection. */
export const CHOOSE_CONNECTION = "choose_connection";

/**
 * The error code of a workspace whose steering still lives in a code
 * repository. import_workspace_steering moves it and provisions.
 */
export const STEERING_IMPORT_REQUIRED = "steering_import_required";

/**
 * The error code of a create the host refused for a reason other than a taken
 * name, such as an organization policy or a billing lock (#4899).
 */
export const REPOSITORY_CREATE_REFUSED = "repository_create_refused";

/**
 * The error code of a workspace whose chosen GitHub organization or GitLab
 * group the organization's stored tokens no longer reach.
 */
export const UNKNOWN_CONNECTION = "unknown_connection";

/** The error code of a name taken by a repository Oxagen did not create here. */
export const REPOSITORY_NAME_TAKEN = "repository_name_taken";

/** The first commit's message. */
export const FIRST_COMMIT_MESSAGE = "Seed the steering repo";

/** The version the first publish records. */
const FIRST_VERSION = 1;

/** How many names a workspace repository tries before giving up. */
const WORKSPACE_NAME_ATTEMPTS = 20;

// ── Shapes ───────────────────────────────────────────────────────────────────

/** Whose steering repo this is. */
export type SteeringRepoScope =
  | { kind: "workspace"; orgId: string; workspaceId: string }
  | { kind: "organization"; orgId: string };

/** The provider connection that holds the organization's steering repos. */
export type SteeringConnection =
  | {
      provider: "github";
      installation_id: number;
      account_login: string;
      /**
       * `User` for the owner's own personal account (#4899). A connection
       * stored before personal accounts were admitted has none, and is an
       * organization.
       */
      account_type?: "Organization" | "User";
    }
  | { provider: "gitlab"; group_id: number; group_path: string };

/** Whether a connection is a person's own GitHub account. */
export function isPersonalConnection(connection: SteeringConnection): boolean {
  return connection.provider === "github" && connection.account_type === "User";
}

export type SteeringRepoStatus = "provisioning" | "ready" | "failed" | "blocked";

/** The repository as provisioning recorded it. */
export interface SteeringRepository {
  /** GitHub's repository id or GitLab's project id. */
  id: number;
  /** The GitHub organization or the GitLab group path. */
  owner: string;
  name: string;
  full_name: string;
  /**
   * The branch the host created the repository with. The first commit moves
   * the default branch to main, so a rerun can no longer read it.
   */
  initial_branch: string;
}

/** What the `steering_repo` setting holds. */
export interface SteeringRepoState {
  status: SteeringRepoStatus;
  /** The last step that finished, or null before the first. */
  step: SteeringRepoStep | null;
  /** The step that failed or stopped, or null. */
  failed_step: SteeringRepoStep | null;
  error: { code: string; message: string } | null;
  provider: "github" | "gitlab" | null;
  /** The name attempt: 1 for `oxagen-<slug>`, 2 for `oxagen-<slug>-2`. */
  attempt: number;
  /** The name the last create tried. */
  candidate: string | null;
  repository: SteeringRepository | null;
  commit_sha: string | null;
  deployment_id: number | null;
  /** `rpb_…` of the steering binding. The organization repo has none. */
  binding_id: string | null;
  /**
   * The connections pick_connection found when there was more than one, for a
   * person to choose between. Empty otherwise.
   */
  connection_choices: SteeringConnection[];
  /**
   * The name a person chose for a workspace's repository, which
   * create_repository makes exactly. Null for `oxagen-<slug>` and its `-2`,
   * `-3` suffixes. The organization repository is always `oxagen-config`.
   */
  requested_name: string | null;
  /**
   * The GitHub installation or GitLab group a person chose for a workspace,
   * which pick_connection checks against the places the stored tokens reach.
   * Null to use the organization's stored connection.
   */
  requested_connection: SteeringConnectionPick | null;
  /**
   * The connection pick_connection resolved `requested_connection` to. Every
   * later step, and every reader of this workspace's steering repo, uses it
   * before the organization's. Null when the workspace uses the
   * organization's.
   */
  connection: SteeringConnection | null;
  updated_at: string;
}

/** What a person chose for a new workspace's steering repo. */
export interface SteeringRepoRequest {
  name?: string | undefined;
  connection?: SteeringConnectionPick | undefined;
}

/** The state before the first step, with what a person chose, if anything. */
export function initialSteeringRepoState(
  now: Date,
  request: SteeringRepoRequest = {},
): SteeringRepoState {
  return {
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
    requested_name: request.name ?? null,
    requested_connection: request.connection ?? null,
    connection: null,
    updated_at: now.toISOString(),
  };
}

/** What a step needs to know about its scope. */
export interface ProvisionTarget {
  /** The Oxagen organization's slug. */
  org_slug: string;
  /** Null for the organization repository. */
  workspace: { slug: string; name: string } | null;
}

/** The Oxagen GitHub App's clients for one organization. */
export interface GithubSteeringClients {
  app: gh.SteeringApp;
  /** A client holding a fresh installation token. */
  installation(installationId: number): Promise<gh.GithubRest>;
  /** A client holding the owner's user token, or null when none is stored. */
  user(): Promise<gh.GithubRest | null>;
}

/** The GitLab group tokens stored for one organization. */
export interface GitlabSteeringClients {
  /** Every group with a stored token. */
  groups(): Promise<gl.SteeringGroup[]>;
  /** A client holding the group's token, or null when none is stored. */
  group(groupId: number): Promise<gl.GitlabRest | null>;
}

/** What the steps read and write outside the providers. */
export interface ProvisionDeps {
  now(): Date;
  load(scope: SteeringRepoScope): Promise<{
    target: ProvisionTarget;
    state: SteeringRepoState | null;
    connection: SteeringConnection | null;
  }>;
  saveState(scope: SteeringRepoScope, state: SteeringRepoState): Promise<void>;
  saveConnection(
    scope: SteeringRepoScope,
    connection: SteeringConnection,
  ): Promise<void>;
  /**
   * Store `connection` as the organization's steering connection only when
   * none is stored, so a workspace's own choice becomes the organization's
   * default without replacing one. Unset, as in tests that do not exercise
   * it, nothing is stored.
   */
  keepConnection?(
    scope: SteeringRepoScope,
    connection: SteeringConnection,
  ): Promise<void>;
  /** Null when the Oxagen GitHub App is not configured. */
  github(scope: SteeringRepoScope): GithubSteeringClients | null;
  gitlab(scope: SteeringRepoScope): GitlabSteeringClients;
  /** Bind the repository to the workspace with role steering. */
  bind(
    scope: Extract<SteeringRepoScope, { kind: "workspace" }>,
    args: {
      connection: SteeringConnection;
      repository: SteeringRepository;
      default_branch: string;
    },
  ): Promise<string>;
  /** Raise the Re-authorize banner for the organization's owners. */
  notifyReauthorize(
    scope: SteeringRepoScope,
    provider: "github" | "gitlab",
  ): Promise<void>;
  /** The URL and token of the hook on a GitLab steering project. */
  steeringHook(scope: SteeringRepoScope, projectId: number): SteeringHookTarget;
  /**
   * Publish the bound steering repo's production head through the version
   * store, after bind_repository binds it (#4732). The repository sync's
   * port, so the first commit takes version 1 in the store every merge
   * numbers from. Unset, as in tests that do not exercise the publish, the
   * step publishes nothing.
   */
  publishFirst?: SyncPublish;
  /**
   * The code repository that still steers the workspace, or null. Unset, as
   * in tests that do not exercise it, pick_connection checks nothing.
   */
  legacySteeringSource?(
    scope: Extract<SteeringRepoScope, { kind: "workspace" }>,
  ): Promise<LegacySteeringSource | null>;
  /**
   * Start the move of the workspace's MCP servers into its steering repo
   * (migrate_tools_to_steering, ADR-245), once the repo is ready. Unset, as
   * in tests that do not exercise it, nothing starts.
   */
  startToolMigration?(
    scope: Extract<SteeringRepoScope, { kind: "workspace" }>,
  ): Promise<void>;
  /**
   * Make `installationId` the workspace's code installation, the `github`
   * connection its code repositories read, when the workspace has none yet.
   * A workspace that has one keeps it. Unset, as in tests that do not
   * exercise it, nothing is attached.
   */
  attachCodeInstallation?(
    scope: Extract<SteeringRepoScope, { kind: "workspace" }>,
    installationId: number,
  ): Promise<void>;
}

/**
 * A step stopped for a reason a retry cannot fix. The job stops instead of
 * retrying, and the workspace shows the step and what to do.
 */
export class SteeringProvisionBlockedError extends Error {
  readonly code: string;
  readonly isNonRetriable = true;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SteeringProvisionBlockedError";
    this.code = code;
  }
}

// ── The steps ────────────────────────────────────────────────────────────────

interface StepContext {
  deps: ProvisionDeps;
  scope: SteeringRepoScope;
  target: ProvisionTarget;
  state: SteeringRepoState;
  connection: SteeringConnection | null;
}

/** Whether the step applies to this scope and provider. */
function stepApplies(
  step: SteeringRepoStep,
  scope: SteeringRepoScope,
  provider: SteeringConnection["provider"] | null,
): boolean {
  if (step === "add_to_installation") return provider === "github";
  if (step === "register_webhook") return provider === "gitlab";
  if (step === "bind_repository") return scope.kind === "workspace";
  return true;
}

function scopeId(scope: SteeringRepoScope): string {
  return scope.kind === "workspace" ? scope.workspaceId : scope.orgId;
}

/**
 * The string only this scope's repository carries in its description. A rerun
 * that finds the name taken adopts the repository when it carries this.
 */
export function steeringRepoMarker(scope: SteeringRepoScope): string {
  return `oxagen-scope:${scopeId(scope)}`;
}

function describeRepository(ctx: StepContext): string {
  const whom = ctx.target.workspace
    ? `the ${ctx.target.workspace.name} workspace`
    : `the ${ctx.target.org_slug} organization`;
  return `Steering records for ${whom}. Oxagen manages this repository. ${steeringRepoMarker(ctx.scope)}`;
}

function baseName(ctx: StepContext): string {
  return ctx.target.workspace
    ? steeringRepoName(ctx.target.workspace.slug)
    : ORGANIZATION_REPO_NAME;
}

function requireConnection(ctx: StepContext): SteeringConnection {
  if (ctx.connection === null)
    throw new Error("the connection step has not recorded a connection");
  return ctx.connection;
}

function requireRepository(ctx: StepContext): SteeringRepository {
  if (ctx.state.repository === null)
    throw new Error("the create step has not recorded a repository");
  return ctx.state.repository;
}

function requireCommit(ctx: StepContext): string {
  if (ctx.state.commit_sha === null)
    throw new Error("the first commit step has not recorded a commit");
  return ctx.state.commit_sha;
}

function requireGithub(ctx: StepContext): GithubSteeringClients {
  const clients = ctx.deps.github(ctx.scope);
  if (clients === null)
    throw new SteeringProvisionBlockedError(
      "steering_app_unconfigured",
      STEERING_APP_UNCONFIGURED_MESSAGE,
    );
  return clients;
}

async function requireGitlab(
  ctx: StepContext,
  connection: Extract<SteeringConnection, { provider: "gitlab" }>,
): Promise<gl.GitlabRest> {
  const rest = await ctx.deps.gitlab(ctx.scope).group(connection.group_id);
  if (rest === null)
    throw new SteeringProvisionBlockedError(
      REAUTHORIZE,
      `No group access token is stored for ${connection.group_path}. An owner must connect the group again.`,
    );
  return rest;
}

async function gitlabBot(rest: gl.GitlabRest): Promise<gl.SteeringBot> {
  const user = await gl.getCurrentUser(rest);
  return {
    symbol: OXAGEN_STEERING_APP,
    user_id: user.id,
    username: user.username,
  };
}

function seedFiles(
  ctx: StepContext,
  provider: SteeringConnection["provider"],
  repository: SteeringRepository,
): gh.SeedFile[] {
  return firstCommitFiles({
    provider,
    organization: ctx.target.org_slug,
    repository: repository.full_name,
    scope: ctx.target.workspace
      ? {
          kind: "workspace",
          slug: ctx.target.workspace.slug,
          label: ctx.target.workspace.name,
        }
      : { kind: "organization" },
  });
}

async function pickConnection(ctx: StepContext): Promise<void> {
  if (ctx.scope.kind === "workspace" && ctx.deps.legacySteeringSource) {
    const legacy = await ctx.deps.legacySteeringSource(ctx.scope);
    if (legacy !== null)
      throw new SteeringProvisionBlockedError(
        STEERING_IMPORT_REQUIRED,
        `${legacy.full_name} still steers this workspace through its .oxagen/ tree. Move its steering to a steering repo, and Oxagen creates the repo in the same run.`,
      );
  }
  if (ctx.scope.kind === "workspace" && ctx.state.requested_connection !== null) {
    await pickRequestedConnection(ctx, ctx.state.requested_connection);
    return;
  }
  if (ctx.connection !== null) {
    ctx.state.provider = ctx.connection.provider;
    ctx.state.connection_choices = [];
    return;
  }
  // A stored token that the host refuses stops this step with a reauthorize
  // banner for that host. The step does not skip the refused host and pick
  // the other one, because the saved choice is permanent and the owner may
  // have meant the host whose token lapsed.
  const candidates = await listSteeringConnections(ctx.deps, ctx.scope);

  const [only] = candidates;
  if (candidates.length > 1) {
    // The blocked step saves the state, so the read can list the choices.
    ctx.state.connection_choices = candidates;
    throw new SteeringProvisionBlockedError(
      CHOOSE_CONNECTION,
      `This organization has ${candidates.length} GitHub organizations and GitLab groups. Choose the one that holds steering repos, then retry.`,
    );
  }
  if (only === undefined)
    throw new SteeringProvisionBlockedError(
      "no_connection",
      "This organization has no GitHub organization with the Oxagen GitHub App installed and no GitLab group token. Connect one, then retry.",
    );
  await ctx.deps.saveConnection(ctx.scope, only);
  ctx.connection = only;
  ctx.state.provider = only.provider;
  ctx.state.connection_choices = [];
}

/**
 * Resolve the place a person chose for this workspace (#5196). A rerun that
 * already resolved it keeps it without asking the host again. A place the
 * stored tokens no longer reach stops the setup before anything is created,
 * and a retry can name another. The first choice also becomes the
 * organization's default, which `oxagen-config` and later workspaces use, but
 * it never replaces a stored one.
 */
async function pickRequestedConnection(
  ctx: StepContext,
  pick: SteeringConnectionPick,
): Promise<void> {
  let connection = ctx.state.connection;
  if (connection === null || !matchesSteeringConnectionPick(connection, pick)) {
    const found = (await listSteeringConnections(ctx.deps, ctx.scope)).find((c) =>
      matchesSteeringConnectionPick(c, pick),
    );
    if (found === undefined)
      throw new SteeringProvisionBlockedError(
        UNKNOWN_CONNECTION,
        `The ${pick.provider === "github" ? "GitHub organization" : "GitLab group"} chosen for this workspace (${pick.provider} ${pick.id}) is not one Oxagen can reach with the organization's stored authorization. Choose another, then retry.`,
      );
    connection = found;
    ctx.state.connection = found;
    await ctx.deps.keepConnection?.(ctx.scope, found);
  }
  ctx.connection = connection;
  ctx.state.provider = connection.provider;
  ctx.state.connection_choices = [];
}

/**
 * The GitHub installations the owner's stored token reaches: each one on an
 * organization, and the one on the owner's own personal account (#4899). A
 * personal account counts only when it is the owner's own, because GitHub
 * creates a repository there only with that person's token. The login is read
 * only when such an installation is listed. GitHub refusing the token throws
 * its reauthorize error.
 */
export async function listGithubSteeringConnections(
  github: GithubSteeringClients | null,
): Promise<SteeringConnection[]> {
  if (github === null) return [];
  const user = await github.user();
  if (user === null) return [];
  const out: SteeringConnection[] = [];
  let login: string | null | undefined;
  for (const installation of await gh.listSteeringInstallations(user)) {
    if (installation.account_type === "User") {
      login ??= await gh.getUserLogin(user);
      if (
        login === null ||
        installation.account_login.toLowerCase() !== login.toLowerCase()
      )
        continue;
    } else if (installation.account_type !== "Organization") continue;
    out.push({
      provider: "github",
      installation_id: installation.id,
      account_login: installation.account_login,
      account_type:
        installation.account_type === "User" ? "User" : "Organization",
    });
  }
  return out;
}

/** The GitLab groups with a stored group token. */
export async function listGitlabSteeringConnections(
  gitlab: GitlabSteeringClients,
): Promise<SteeringConnection[]> {
  return (await gitlab.groups()).map((group) => ({
    provider: "gitlab",
    group_id: group.id,
    group_path: group.full_path,
  }));
}

/**
 * Every place the organization's stored tokens reach, GitHub first.
 * pick_connection and list_steering_repo_destinations both read this, so a
 * create form never offers a place the job would refuse.
 */
export async function listSteeringConnections(
  deps: Pick<ProvisionDeps, "github" | "gitlab">,
  scope: SteeringRepoScope,
): Promise<SteeringConnection[]> {
  return [
    ...(await listGithubSteeringConnections(deps.github(scope))),
    ...(await listGitlabSteeringConnections(deps.gitlab(scope))),
  ];
}

/** A connection a person picked by its provider and id. */
export interface SteeringConnectionPick {
  provider: "github" | "gitlab";
  /** The GitHub installation id or the GitLab group id. */
  id: number;
}

/** Whether `connection` is the one `pick` names. */
export function matchesSteeringConnectionPick(
  connection: SteeringConnection,
  pick: SteeringConnectionPick,
): boolean {
  return (
    connection.provider === pick.provider &&
    steeringConnectionId(connection) === pick.id
  );
}

/** The id a person picks a connection by. */
export function steeringConnectionId(connection: SteeringConnection): number {
  return connection.provider === "github"
    ? connection.installation_id
    : connection.group_id;
}

/** The name a person reads a connection by. */
export function steeringConnectionName(connection: SteeringConnection): string {
  return connection.provider === "github"
    ? connection.account_login
    : connection.group_path;
}

/** A connection as the contracts name it: provider, id, name, and kind. */
export function steeringConnectionChoiceOf(connection: SteeringConnection): {
  provider: "github" | "gitlab";
  id: number;
  name: string;
  kind: "organization" | "user";
} {
  return {
    provider: connection.provider,
    id: steeringConnectionId(connection),
    name: steeringConnectionName(connection),
    kind: isPersonalConnection(connection) ? "user" : "organization",
  };
}

/**
 * The recorded choice that `pick` names, or null when the state records no
 * such choice. Only a connection pick_connection found can be stored, so a
 * caller cannot point the organization at a host its tokens do not reach.
 */
export function pickSteeringConnection(
  state: SteeringRepoState | null,
  pick: SteeringConnectionPick,
): SteeringConnection | null {
  return (
    state?.connection_choices.find((c) =>
      matchesSteeringConnectionPick(c, pick),
    ) ?? null
  );
}

async function createRepositoryStep(ctx: StepContext): Promise<void> {
  if (ctx.state.repository !== null) return;
  const connection = requireConnection(ctx);
  // A name a person chose is made exactly, on one attempt: a suffix would
  // give them a name they never saw.
  const exact = ctx.scope.kind === "workspace" ? ctx.state.requested_name : null;
  const base_name = exact ?? baseName(ctx);
  // The `config` workspace's first name is the organization's own
  // `oxagen-config`, so it starts at `oxagen-config-2`.
  const reserved =
    exact === null &&
    ctx.scope.kind === "workspace" &&
    base_name === ORGANIZATION_REPO_NAME;
  const first_attempt =
    exact === null ? Math.max(reserved ? 2 : 1, ctx.state.attempt) : 1;
  const max_attempts =
    exact !== null || ctx.scope.kind === "organization"
      ? 1
      : WORKSPACE_NAME_ATTEMPTS;
  const on_attempt = async (attempt: number, name: string) => {
    ctx.state.attempt = attempt;
    ctx.state.candidate = name;
    await save(ctx);
  };
  if (connection.provider === "github") {
    const github = requireGithub(ctx);
    const rest = await github.installation(connection.installation_id);
    const user = await github.user();
    // A personal account's repository is created with the owner's own token,
    // because GitHub lets no installation token create one there (#4899).
    const personal = isPersonalConnection(connection);
    if (personal && user === null)
      throw new SteeringProvisionBlockedError(
        REAUTHORIZE,
        `Oxagen needs ${connection.account_login}'s own authorization to create a repository in that personal account. Authorize the Oxagen GitHub App again.`,
      );
    let created: gh.CreateOrAdoptResult;
    try {
      created = await gh.createOrAdoptRepository(
        personal && user !== null ? user : rest,
        {
          org: connection.account_login,
          owner_kind: personal ? "user" : "organization",
          base_name,
          description: describeRepository(ctx),
          marker: steeringRepoMarker(ctx.scope),
          first_attempt,
          max_attempts,
          // The app cannot see a repository outside its installation. The
          // owner's token can, so it looks a taken name up too.
          lookups: user === null ? [rest] : [rest, user],
          on_attempt,
        },
      );
    } catch (err) {
      throw createRefused(err, "GitHub", connection.account_login, exact);
    }
    const { repository } = created;
    ctx.state.repository = {
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      full_name: repository.full_name,
      initial_branch: repository.default_branch,
    };
    return;
  }
  const rest = await requireGitlab(ctx, connection);
  let created: Awaited<ReturnType<typeof gl.createOrAdoptProject>>;
  try {
    created = await gl.createOrAdoptProject(rest, {
      group: { id: connection.group_id, full_path: connection.group_path },
      base_name,
      description: describeRepository(ctx),
      marker: steeringRepoMarker(ctx.scope),
      first_attempt,
      max_attempts,
      on_attempt,
    });
  } catch (err) {
    throw createRefused(err, "GitLab", connection.group_path, exact);
  }
  const { project } = created;
  ctx.state.repository = {
    id: project.id,
    owner: project.namespace_path,
    name: project.name,
    full_name: project.path_with_namespace,
    initial_branch: project.default_branch,
  };
}

/**
 * Why the create step cannot go on. Every name taken by a repository this
 * scope did not create is `repository_name_taken`. Any other refusal of the
 * create, such as an organization policy or a billing lock, is
 * `repository_create_refused` with the host's own message (#4899). Before,
 * both read as a taken name. Anything else is retried. A taken name a person
 * chose (`exact`) says so, because a retry can name another.
 */
function createRefused(
  err: unknown,
  host: "GitHub" | "GitLab",
  account: string,
  exact: string | null = null,
): unknown {
  const status =
    err instanceof GitHubApiError
      ? err.status
      : err instanceof gl.GitLabApiError
        ? err.status
        : null;
  // A rate limit is a 403 too, and the job retries it after the window.
  if (err instanceof GitHubRateLimitedError) return err;
  if (status !== 422 && status !== 400 && status !== 403) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/Every name from /.test(message))
    return new SteeringProvisionBlockedError(
      REPOSITORY_NAME_TAKEN,
      exact === null
        ? message
        : `${account} already has a repository named ${exact} that Oxagen did not create for this workspace. Choose another name, then retry.`,
    );
  return new SteeringProvisionBlockedError(
    REPOSITORY_CREATE_REFUSED,
    `${host} refused to create a repository in ${account}: ${message} If ${account} has a repository policy that restricts creations, add the Oxagen app to its allow list. Otherwise check the account's billing and repository settings, or use a different organization.`,
  );
}

async function addToInstallation(ctx: StepContext): Promise<void> {
  const connection = requireConnection(ctx);
  if (connection.provider !== "github") return;
  const repository = requireRepository(ctx);
  const github = requireGithub(ctx);
  const user = await github.user();
  if (user === null)
    throw new SteeringProvisionBlockedError(
      REAUTHORIZE,
      "No organization owner has authorized the Oxagen GitHub App for steering. An owner must authorize it.",
    );
  const installation = (await gh.listSteeringInstallations(user)).find(
    (i) => i.id === connection.installation_id,
  );
  if (installation === undefined)
    throw new SteeringProvisionBlockedError(
      REAUTHORIZE,
      `The stored steering authorization cannot reach the Oxagen GitHub App installation on ${connection.account_login}. An owner must authorize it again.`,
    );
  // An installation on every repository already holds the new one.
  if (installation.repository_selection === "all") return;
  await gh.addRepositoryToInstallation(user, {
    installation_id: connection.installation_id,
    repository_id: repository.id,
  });
}

async function writeFirstCommitStep(ctx: StepContext): Promise<void> {
  const connection = requireConnection(ctx);
  const repository = requireRepository(ctx);
  const files = seedFiles(ctx, connection.provider, repository);
  if (connection.provider === "github") {
    const rest = await requireGithub(ctx).installation(
      connection.installation_id,
    );
    const out = await gh.writeFirstCommit(rest, {
      repo: { owner: repository.owner, name: repository.name },
      files,
      message: FIRST_COMMIT_MESSAGE,
      initial_branch: repository.initial_branch,
    });
    ctx.state.commit_sha = out.commit_sha;
    return;
  }
  const rest = await requireGitlab(ctx, connection);
  const out = await gl.writeFirstCommit(rest, {
    project_id: repository.id,
    files,
    message: FIRST_COMMIT_MESSAGE,
  });
  ctx.state.commit_sha = out.commit_sha;
}

async function applySettingsStep(ctx: StepContext): Promise<void> {
  const connection = requireConnection(ctx);
  const repository = requireRepository(ctx);
  let remaining: readonly { setting: string }[];
  if (connection.provider === "github") {
    const github = requireGithub(ctx);
    const rest = await github.installation(connection.installation_id);
    ({ remaining } = await gh.applySettings(
      rest,
      { owner: repository.owner, name: repository.name },
      github.app,
      GITHUB_SETTINGS_BASELINE,
    ));
  } else {
    const rest = await requireGitlab(ctx, connection);
    ({ remaining } = await gl.applyGitlabSettings(
      rest,
      repository.id,
      await gitlabBot(rest),
      GITLAB_SETTINGS_BASELINE,
    ));
  }
  if (remaining.length > 0)
    throw new Error(
      `After applying the settings, ${remaining.length} still differ: ${remaining.map((d) => d.setting).join(", ")}`,
    );
}

/**
 * Register the hook that tells Oxagen about pushes and merges on a GitLab
 * steering project. A GitHub steering repo skips this step. A rerun writes
 * the current token onto the same hook, so it also heals a rotated secret.
 *
 * GitLab answers 400 or 422 when it refuses the hook's URL, as GitLab.com
 * does for a localhost API origin (`NEXT_PUBLIC_API_URL`). A retry gets the same answer, and
 * the repo works without the hook: the scheduled sweep finds the changes the
 * hook would have reported, only later. So a refused URL logs a warning and
 * the step finishes. A run after the URL is fixed registers the hook.
 */
async function registerWebhook(ctx: StepContext): Promise<void> {
  const connection = requireConnection(ctx);
  if (connection.provider !== "gitlab") return;
  const repository = requireRepository(ctx);
  const rest = await requireGitlab(ctx, connection);
  const { url, token } = ctx.deps.steeringHook(ctx.scope, repository.id);
  try {
    await gl.ensureSteeringHook(rest, { project_id: repository.id, url, token });
  } catch (err) {
    if (
      !(err instanceof gl.GitLabApiError) ||
      (err.status !== 400 && err.status !== 422)
    )
      throw err;
    logger.warn(
      {
        orgId: ctx.scope.orgId,
        scope: ctx.scope.kind,
        projectId: repository.id,
        url,
        err: err.message,
      },
      "steering_repo.provision: GitLab refused the steering hook's URL; the scheduled sweep reports changes until a run registers the hook",
    );
  }
}

async function publishVersion(ctx: StepContext): Promise<void> {
  const connection = requireConnection(ctx);
  const repository = requireRepository(ctx);
  const sha = requireCommit(ctx);
  if (connection.provider === "github") {
    const rest = await requireGithub(ctx).installation(
      connection.installation_id,
    );
    const out = await gh.recordDeployment(rest, {
      repo: { owner: repository.owner, name: repository.name },
      environment: STEERING_ENVIRONMENT,
      ref: STEERING_DEFAULT_BRANCH,
      sha,
      version: FIRST_VERSION,
      description: `Version ${FIRST_VERSION}`,
    });
    ctx.state.deployment_id = out.deployment_id;
    return;
  }
  const rest = await requireGitlab(ctx, connection);
  const out = await gl.recordGitlabDeployment(rest, {
    project_id: repository.id,
    environment: STEERING_ENVIRONMENT,
    ref: STEERING_DEFAULT_BRANCH,
    sha,
  });
  ctx.state.deployment_id = out.deployment_id;
}

/**
 * Give the workspace the steering installation as its code installation when
 * it has none. A failure is logged and never fails the step. The workspace
 * then stays as it was before this call, and a person can still choose an
 * installation in the app.
 */
async function attachCodeInstallation(
  ctx: StepContext,
  scope: Extract<SteeringRepoScope, { kind: "workspace" }>,
  installationId: number,
): Promise<void> {
  const attach = ctx.deps.attachCodeInstallation;
  if (attach === undefined) return;
  try {
    await attach(scope, installationId);
  } catch (err) {
    logger.warn(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "steering_repo.provision: the steering repo is bound, but its installation was not attached as the workspace's GitHub connection; a person can choose one in the app",
    );
  }
}

async function bindRepository(ctx: StepContext): Promise<void> {
  if (ctx.scope.kind !== "workspace") return;
  const repository = requireRepository(ctx);
  const connection = requireConnection(ctx);
  ctx.state.binding_id = await ctx.deps.bind(ctx.scope, {
    connection,
    repository,
    default_branch: STEERING_DEFAULT_BRANCH,
  });
  // The bind writes a `github_steering` connection. The workspace's code
  // repositories read only a `github` connection
  // (`resolveWorkspaceGithubInstallation`), so without this step a new
  // workspace lists no repositories. create_workspace attached that
  // connection until #4462 removed it (ADR-099 §1-2). The steering
  // installation can differ from the code installation (lib/steering-app.ts),
  // so this only sets a default for a workspace that has no `github`
  // connection. add_to_installation found this installation through the
  // owner's stored token (`/user/installations`), and the earlier steps wrote
  // the first commit through it, so the organization reaches it. GitLab has
  // no code installation, so it gets nothing.
  if (connection.provider === "github")
    await attachCodeInstallation(ctx, ctx.scope, connection.installation_id);
  // The publish resolves the repository from the binding written above, so it
  // runs after the bind. A rerun finds the head published and answers
  // `current`.
  await publishFirstVersion(
    ctx.deps.publishFirst,
    ctx.scope,
    repository.full_name,
  );
}

const STEP_BODIES: Record<SteeringRepoStep, (ctx: StepContext) => Promise<void>> =
  {
    pick_connection: pickConnection,
    create_repository: createRepositoryStep,
    add_to_installation: addToInstallation,
    write_first_commit: writeFirstCommitStep,
    apply_settings: applySettingsStep,
    register_webhook: registerWebhook,
    publish_version: publishVersion,
    bind_repository: bindRepository,
  };

async function save(ctx: StepContext): Promise<void> {
  ctx.state.updated_at = ctx.deps.now().toISOString();
  await ctx.deps.saveState(ctx.scope, ctx.state);
}

function lastStep(scope: SteeringRepoScope): SteeringRepoStep {
  return scope.kind === "workspace" ? "bind_repository" : "publish_version";
}

/**
 * Start the move of the workspace's MCP servers into its new steering repo
 * (ADR-245, #4948), once the last step has made the repo ready. The move is
 * safe to repeat, so a rerun of the last step starts it again and finds the
 * PR it opened. A failure is logged and never fails the step: the repo is
 * ready, and migrate_tools_to_steering retries the move.
 */
async function startToolMigration(ctx: StepContext): Promise<void> {
  const start = ctx.deps.startToolMigration;
  const scope = ctx.scope;
  if (start === undefined || scope.kind !== "workspace") return;
  try {
    await start(scope);
  } catch (err) {
    logger.warn(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "steering_repo.provision: the steering repo is ready, but its MCP servers did not start moving into it; migrate_tools_to_steering retries the move",
    );
  }
}

/**
 * Whether an owner has to authorize again: the token is missing, or the host
 * refused it. Both provider errors and the blocked error carry this code.
 */
/**
 * The host whose authorization a reauthorize stop asks for. A stop inside
 * `pick_connection` comes before any provider is recorded, so the error class
 * names the host there.
 */
function reauthorizeHost(
  err: unknown,
  provider: "github" | "gitlab" | null,
): "github" | "gitlab" {
  if (err instanceof gl.SteeringGitlabReauthorizeError) return "gitlab";
  if (err instanceof gh.SteeringReauthorizeError) return "github";
  return provider ?? "github";
}

function isReauthorize(err: unknown): boolean {
  return (
    err instanceof gh.SteeringReauthorizeError ||
    err instanceof gl.SteeringGitlabReauthorizeError ||
    (err instanceof SteeringProvisionBlockedError && err.code === REAUTHORIZE)
  );
}

export interface StepOutcome {
  step: SteeringRepoStep;
  status: SteeringRepoStatus;
  /** False when the step does not apply to this scope or provider. */
  ran: boolean;
}

/**
 * Run one step and record what it made. A step that fails records its name
 * and error and rethrows, so the job retries it. A step that cannot succeed on
 * a retry records `blocked` and throws `SteeringProvisionBlockedError`.
 */
export async function runSteeringRepoStep(
  deps: ProvisionDeps,
  scope: SteeringRepoScope,
  step: SteeringRepoStep,
): Promise<StepOutcome> {
  const loaded = await deps.load(scope);
  const ctx: StepContext = {
    deps,
    scope,
    target: loaded.target,
    state: loaded.state ?? initialSteeringRepoState(deps.now()),
    connection: loaded.connection,
  };
  const provider = ctx.connection?.provider ?? ctx.state.provider;
  if (step !== "pick_connection" && !stepApplies(step, scope, provider))
    return { step, status: ctx.state.status, ran: false };

  const previous = ctx.state.error;
  try {
    await STEP_BODIES[step](ctx);
  } catch (err) {
    const blocked =
      err instanceof SteeringProvisionBlockedError || isReauthorize(err);
    const code = isReauthorize(err)
      ? REAUTHORIZE
      : err instanceof SteeringProvisionBlockedError
        ? err.code
        : "step_failed";
    const message = err instanceof Error ? err.message : String(err);
    ctx.state.status = blocked ? "blocked" : "failed";
    ctx.state.failed_step = step;
    ctx.state.error = { code, message };
    await save(ctx);
    logger.warn(
      { orgId: scope.orgId, scope: scope.kind, step, code, err: message },
      "steering_repo.provision: step did not finish",
    );
    if (isReauthorize(err)) {
      // One banner per stop, not one per retry.
      if (previous?.code !== code)
        await deps.notifyReauthorize(scope, reauthorizeHost(err, provider));
      throw new SteeringProvisionBlockedError(code, message);
    }
    throw err;
  }

  ctx.state.step = step;
  ctx.state.failed_step = null;
  ctx.state.error = null;
  ctx.state.status = step === lastStep(scope) ? "ready" : "provisioning";
  await save(ctx);
  if (ctx.state.status === "ready") await startToolMigration(ctx);
  return { step, status: ctx.state.status, ran: true };
}

/** Run every step in order. The durable job runs them one by one instead. */
export async function provisionSteeringRepo(
  deps: ProvisionDeps,
  scope: SteeringRepoScope,
): Promise<SteeringRepoStatus> {
  let status: SteeringRepoStatus = "provisioning";
  for (const step of STEERING_REPO_STEPS)
    ({ status } = await runSteeringRepoStep(deps, scope, step));
  return status;
}

// ── Production dependencies ──────────────────────────────────────────────────

/** Read the state a settings bag holds, or null when it holds none. */
export function readSteeringRepoState(
  settings: unknown,
): SteeringRepoState | null {
  const value = bagValue(settings, STEERING_REPO_SETTING);
  if (value === null || typeof value !== "object") return null;
  const state = value as Partial<SteeringRepoState>;
  if (typeof state.status !== "string") return null;
  return {
    ...initialSteeringRepoState(new Date(0)),
    ...state,
    connection: parseSteeringConnection(state.connection ?? null),
  };
}

/** Read the connection a settings bag names, or null when it names none. */
export function readSteeringConnection(
  settings: unknown,
): SteeringConnection | null {
  return parseSteeringConnection(bagValue(settings, STEERING_CONNECTION_SETTING));
}

/** A stored connection, or null when `value` is not one. */
function parseSteeringConnection(value: unknown): SteeringConnection | null {
  if (value === null || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (
    c["provider"] === "github" &&
    typeof c["installation_id"] === "number" &&
    typeof c["account_login"] === "string"
  )
    return {
      provider: "github",
      installation_id: c["installation_id"],
      account_login: c["account_login"],
      ...(c["account_type"] === "User" || c["account_type"] === "Organization"
        ? { account_type: c["account_type"] }
        : {}),
    };
  if (
    c["provider"] === "gitlab" &&
    typeof c["group_id"] === "number" &&
    typeof c["group_path"] === "string"
  )
    return {
      provider: "gitlab",
      group_id: c["group_id"],
      group_path: c["group_path"],
    };
  return null;
}

function bagValue(settings: unknown, key: string): unknown {
  if (settings === null || typeof settings !== "object") return null;
  return (settings as Record<string, unknown>)[key] ?? null;
}

/** Mint an installation token for the Oxagen GitHub App. */
export async function steeringInstallationRest(
  config: { app: gh.SteeringApp; privateKey: string },
  installationId: number,
): Promise<gh.GithubRest> {
  const { token } = await createAppInstallationToken({
    appId: String(config.app.id),
    privateKey: config.privateKey,
    installationId,
  });
  return gh.createGithubRest({ token });
}

// ── Production wiring ────────────────────────────────────────────────────────

/** An encrypted token as `oauth_accounts.access_token_enc` stores it. */
interface EncryptedToken {
  ciphertext: string;
  keyId: string;
}

/** A token an owner stored for steering repos, decrypted. */
interface StoredToken {
  /** The GitHub user id, or the GitLab group id. */
  provider_user_id: string;
  token: string;
}

/**
 * The stored group access token for one GitLab group, or null when none is
 * stored or it cannot be used. `provider_user_id` holds the group's id. The
 * steering readers call this for a head whose connection is `gitlab_steering`,
 * because that token lives on the organization, not on the connection.
 */
export async function steeringGroupToken(
  orgId: string,
  groupId: number,
): Promise<string | null> {
  for (const stored of await storedTokens(orgId, GITLAB_STEERING_PROVIDER))
    if (Number(stored.provider_user_id) === groupId) return stored.token;
  return null;
}

/**
 * The tokens stored under `provider` for one organization, newest first. A
 * token that has expired or cannot be decrypted is left out, so the step that
 * needs it asks an owner to authorize again instead of sending a token the
 * provider refuses.
 */
async function storedTokens(
  orgId: string,
  provider: string,
): Promise<StoredToken[]> {
  // tenancy: filtered by orgId and provider. The provision job runs outside a
  // tenant scope, and its event carries the orgId create_workspace or
  // create_organization verified before sending it.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        providerUserId: schema.oauthAccounts.providerUserId,
        accessTokenEnc: schema.oauthAccounts.accessTokenEnc,
        expiresAt: schema.oauthAccounts.expiresAt,
      })
      .from(schema.oauthAccounts)
      .where(
        and(
          eq(schema.oauthAccounts.orgId, orgId),
          eq(schema.oauthAccounts.provider, provider),
        ),
      )
      .orderBy(desc(schema.oauthAccounts.updatedAt)),
  );
  const out: StoredToken[] = [];
  const now = Date.now();
  for (const row of rows) {
    const enc = row.accessTokenEnc as EncryptedToken | null;
    if (!enc) continue;
    // A null expiry is a token that does not expire.
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now) continue;
    try {
      const { adapter } = resolveIngestionCryptoAdapterForKeyId(enc.keyId);
      const plain = await decrypt(
        Buffer.from(enc.ciphertext, "base64"),
        enc.keyId,
        { adapter },
      );
      out.push({
        provider_user_id: row.providerUserId,
        token: plain.toString("utf8"),
      });
    } catch (err) {
      logger.warn(
        { orgId, provider, err: String(err) },
        "steering_repo.provision: a stored token could not be decrypted",
      );
    }
  }
  return out;
}

/** Merge `patch` into a jsonb settings column. */
function mergeSettings(
  column: typeof schema.workspaces.settings | typeof schema.organizations.settings,
  patch: Record<string, unknown>,
) {
  return sql`CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * A settings value with the `steering_repo` key set to `state`, for an update
 * that runs on a transaction the caller already holds.
 */
export function settingsWithSteeringRepo(
  column: typeof schema.workspaces.settings | typeof schema.organizations.settings,
  state: SteeringRepoState,
) {
  return mergeSettings(column, { [STEERING_REPO_SETTING]: state });
}

/** Write the `steering_repo` setting of a workspace or an organization. */
export async function saveSteeringRepoState(
  scope: SteeringRepoScope,
  state: SteeringRepoState,
): Promise<void> {
  const patch = { [STEERING_REPO_SETTING]: state };
  if (scope.kind === "workspace") {
    // tenancy: filtered by workspaceId and orgId together, both from the
    // provision event that create_workspace sent after it verified the
    // caller's membership.
    await withSystemDb((tx) =>
      tx
        .update(schema.workspaces)
        .set({ settings: mergeSettings(schema.workspaces.settings, patch) })
        .where(
          and(
            eq(schema.workspaces.id, scope.workspaceId),
            eq(schema.workspaces.orgId, scope.orgId),
          ),
        ),
    );
    return;
  }
  // tenancy: filtered by orgId from the provision event, which
  // create_organization sent after it verified the caller created the org.
  await withSystemDb((tx) =>
    tx
      .update(schema.organizations)
      .set({ settings: mergeSettings(schema.organizations.settings, patch) })
      .where(eq(schema.organizations.id, scope.orgId)),
  );
}

/**
 * Store `connection` as the organization's steering connection: the one
 * connection pick_connection found that the owner's tokens reach. A person's
 * pick goes through `storeChosenSteeringConnection` instead.
 */
export async function saveSteeringConnection(
  orgId: string,
  connection: SteeringConnection,
): Promise<void> {
  const patch = { [STEERING_CONNECTION_SETTING]: connection };
  // tenancy: filtered by orgId from the provision event. The connection is
  // the one candidate this org's own stored tokens reach.
  await withSystemDb((tx) =>
    tx
      .update(schema.organizations)
      .set({ settings: mergeSettings(schema.organizations.settings, patch) })
      .where(eq(schema.organizations.id, orgId)),
  );
}

/** Whether two connections name the same installation or group. */
function sameSteeringConnection(
  a: SteeringConnection,
  b: SteeringConnection,
): boolean {
  return (
    a.provider === b.provider &&
    steeringConnectionId(a) === steeringConnectionId(b)
  );
}

/**
 * Store the connection a person picked from a setup's recorded choices. The
 * organization has one steering connection, so the store is a compare and
 * set: the first pick stands, the same pick again is a no-op, and a different
 * one is refused (conflict `connection_already_chosen`). Without this, two
 * workspaces waiting on a choice could each store their own, and a queued job
 * would create its repo wherever the last pick pointed (#4877).
 */
export async function storeChosenSteeringConnection(
  orgId: string,
  connection: SteeringConnection,
): Promise<void> {
  if (await keepSteeringConnection(orgId, connection)) return;
  // tenancy: filtered by orgId, which the kernel's capability context names.
  const [org] = await withSystemDb((tx) =>
    tx
      .select({ settings: schema.organizations.settings })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1),
  );
  const stored = readSteeringConnection(org?.settings);
  if (stored !== null && sameSteeringConnection(stored, connection)) return;
  throw new HandlerError({
    code: "conflict",
    reason: "connection_already_chosen",
    message:
      stored === null
        ? "The organization's steering connection could not be stored. Try again."
        : `This organization already creates steering repos in ${steeringConnectionName(stored)}. Retry without a connection to use it.`,
  });
}

/**
 * The first repository a setup recorded in the account `connection` names,
 * or null when no setup made one there. A GitLab project in a subgroup of the
 * connected group counts as the group's.
 */
export function repositoryOnConnection(
  connection: SteeringConnection,
  states: readonly (SteeringRepoState | null)[],
): SteeringRepository | null {
  for (const state of states) {
    const repository = state?.repository ?? null;
    if (repository === null) continue;
    if (connection.provider === "github") {
      if (state?.provider !== "github") continue;
      if (repository.owner.toLowerCase() === connection.account_login.toLowerCase())
        return repository;
      continue;
    }
    if (state?.provider !== "gitlab") continue;
    if (
      repository.owner === connection.group_path ||
      repository.owner.startsWith(`${connection.group_path}/`)
    )
      return repository;
  }
  return null;
}

/** How long a `provisioning` setup that has not saved still counts as running. */
export const RESET_RUNNING_MS = 10 * 60 * 1000;

/** One setup of the organization: its own (`key` null) or a workspace's. */
export interface ResetScope {
  key: string | null;
  state: SteeringRepoState | null;
}

/** What a reset of the organization's connection would do. */
export type ConnectionResetPlan =
  | {
      kind: "refuse";
      reason: "setup_running" | "connection_in_use";
      repository?: SteeringRepository;
    }
  | { kind: "clear"; release: (string | null)[] };

/**
 * Decide a reset of the organization's steering connection (#4899, #4900).
 *
 * - A setup that saved as `provisioning` within `RESET_RUNNING_MS` may be
 *   between reading the old connection and recording a repository there, so
 *   the reset waits for it (`setup_running`).
 * - A repository in the stored account pins the connection once its setup
 *   published a version, bound it, or finished (`connection_in_use`).
 * - A repository in the stored account whose setup stopped before any of
 *   that, such as when GitHub refuses a prescribed settings write, does not
 *   pin it. The reset releases that setup: its record of
 *   the repository is cleared, so the next run creates one in the new place.
 *   The repository stays on the host for a person to delete.
 */
export function planConnectionReset(
  connection: SteeringConnection,
  scopes: readonly ResetScope[],
  now: Date,
): ConnectionResetPlan {
  const release: (string | null)[] = [];
  for (const { key, state } of scopes) {
    // A workspace with its own connection does not use the organization's,
    // so the reset neither waits on it nor releases it.
    if (state === null || state.connection !== null) continue;
    if (
      state.status === "provisioning" &&
      now.getTime() - Date.parse(state.updated_at) < RESET_RUNNING_MS
    )
      return { kind: "refuse", reason: "setup_running" };
    const repository = repositoryOnConnection(connection, [state]);
    if (repository === null) continue;
    if (
      state.status === "ready" ||
      state.deployment_id !== null ||
      state.binding_id !== null
    )
      return { kind: "refuse", reason: "connection_in_use", repository };
    release.push(key);
  }
  return { kind: "clear", release };
}

/** A setup's state with its record of an unpublished repository cleared. */
export function releasedSteeringRepoState(
  state: SteeringRepoState,
  now: Date,
): SteeringRepoState {
  return {
    ...state,
    step: null,
    attempt: 1,
    candidate: null,
    repository: null,
    commit_sha: null,
    connection_choices: [],
    updated_at: now.toISOString(),
  };
}

/**
 * Clear the organization's steering connection so the next run lists the
 * candidates again and a person picks one (#4899). Mac decided on 2026-10-01
 * that an owner may change the organization until Oxagen has created a
 * steering repo in it. `planConnectionReset` decides what that means for each
 * setup. Answers the connection it cleared, or null when none was stored.
 */
export async function resetSteeringConnection(
  orgId: string,
): Promise<SteeringConnection | null> {
  const now = new Date();
  // tenancy: filtered by orgId, which the kernel's capability context names.
  // The check reads every setup of the organization, and the writes touch
  // only that organization's own settings and its workspaces' settings.
  return withSystemDb(async (tx) => {
    const [org] = await tx
      .select({ settings: schema.organizations.settings })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);
    const stored = readSteeringConnection(org?.settings);
    if (stored === null) return null;
    const workspaces = await tx
      .select({ id: schema.workspaces.id, settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.orgId, orgId));
    const states = new Map<string | null, SteeringRepoState | null>([
      [null, readSteeringRepoState(org?.settings)],
      ...workspaces.map(
        (w): [string, SteeringRepoState | null] => [
          w.id,
          readSteeringRepoState(w.settings),
        ],
      ),
    ]);
    const plan = planConnectionReset(
      stored,
      [...states].map(([key, state]) => ({ key, state })),
      now,
    );
    if (plan.kind === "refuse")
      throw new HandlerError({
        code: "conflict",
        reason: plan.reason,
        message:
          plan.reason === "setup_running"
            ? "A steering repo setup of this organization is running. Wait for it to stop, then change the organization."
            : `Oxagen already created ${plan.repository?.full_name ?? "a steering repo"} in ${steeringConnectionName(stored)}, so this organization's steering repos stay there.`,
      });
    for (const key of plan.release) {
      const state = states.get(key) ?? null;
      if (state === null) continue;
      const released = releasedSteeringRepoState(state, now);
      if (key === null)
        await tx
          .update(schema.organizations)
          .set({
            settings: settingsWithSteeringRepo(schema.organizations.settings, released),
          })
          .where(eq(schema.organizations.id, orgId));
      else
        await tx
          .update(schema.workspaces)
          .set({
            settings: settingsWithSteeringRepo(schema.workspaces.settings, released),
          })
          .where(
            and(eq(schema.workspaces.id, key), eq(schema.workspaces.orgId, orgId)),
          );
    }
    await tx
      .update(schema.organizations)
      .set({
        settings: sql`CASE WHEN jsonb_typeof(${schema.organizations.settings}) = 'object' THEN ${schema.organizations.settings} ELSE '{}'::jsonb END - ${STEERING_CONNECTION_SETTING}::text`,
      })
      .where(eq(schema.organizations.id, orgId));
    return stored;
  });
}

/**
 * Store `connection` as the organization's steering connection unless the
 * organization already has one. The choice is permanent, so a later connect
 * never replaces it. Returns whether this call stored it.
 */
export async function keepSteeringConnection(
  orgId: string,
  connection: SteeringConnection,
): Promise<boolean> {
  const patch = { [STEERING_CONNECTION_SETTING]: connection };
  // tenancy: filtered by orgId, which the caller took from a signed state. The
  // caller checked that the owner's own token reaches the connection.
  const rows = await withSystemDb((tx) =>
    tx
      .update(schema.organizations)
      .set({ settings: mergeSettings(schema.organizations.settings, patch) })
      .where(
        and(
          eq(schema.organizations.id, orgId),
          sql`(${schema.organizations.settings} -> ${STEERING_CONNECTION_SETTING}::text) IS NULL`,
        ),
      )
      .returning({ id: schema.organizations.id }),
  );
  return rows.length > 0;
}

/**
 * Point the organization's GitHub steering connection, and every steering
 * source connection bound from it, at `connection` when the stored connection
 * names a different installation on the same GitHub account.
 *
 * A GitHub App has one installation per account, and the caller checked that
 * the owner's own token reaches `connection`. So a different stored id on the
 * same account belongs to the retired Oxagen Steering app or to an
 * installation the owner removed, and no token the deployment mints can use it
 * (ADR-228). The connection never moves to another account or host, as
 * `keepSteeringConnection` says. Returns the installation id it replaced, or
 * null when it changed nothing.
 */
export async function moveSteeringInstallation(
  orgId: string,
  connection: Extract<SteeringConnection, { provider: "github" }>,
  actorUserId: string,
): Promise<number | null> {
  // tenancy: filtered by orgId, which the caller took from a signed state. The
  // caller checked that the owner's own token reaches the connection.
  return withSystemDb(async (tx) => {
    const [org] = await tx
      .select({ settings: schema.organizations.settings })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);
    const stored = readSteeringConnection(org?.settings);
    if (
      stored?.provider !== "github" ||
      stored.installation_id === connection.installation_id ||
      stored.account_login.toLowerCase() !==
        connection.account_login.toLowerCase()
    )
      return null;
    const from = stored.installation_id;
    // The where clause repeats the id it read, so a connect that races this
    // one and already moved the setting leaves it alone.
    const moved = await tx
      .update(schema.organizations)
      .set({
        settings: mergeSettings(schema.organizations.settings, {
          [STEERING_CONNECTION_SETTING]: connection,
        }),
      })
      .where(
        and(
          eq(schema.organizations.id, orgId),
          sql`(${schema.organizations.settings} -> ${STEERING_CONNECTION_SETTING}::text ->> 'installation_id') = ${String(from)}`,
        ),
      )
      .returning({ id: schema.organizations.id });
    if (moved.length === 0) return null;
    await tx
      .update(schema.sourceConnections)
      .set({
        deliveryConfig: sql`jsonb_set(${schema.sourceConnections.deliveryConfig}, '{installationId}', ${JSON.stringify(connection.installation_id)}::jsonb)`,
        updatedAt: new Date(),
        updatedById: actorUserId,
      })
      .where(
        and(
          eq(schema.sourceConnections.orgId, orgId),
          eq(schema.sourceConnections.connectorId, GITHUB_STEERING_PROVIDER),
          isNull(schema.sourceConnections.deletedAt),
          sql`(${schema.sourceConnections.deliveryConfig} ->> 'installationId') = ${String(from)}`,
        ),
      );
    return from;
  });
}

/** The email body. The in-app notification carries the link. */
function reauthorizeEmail(title: string, body: string): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  return `<p><strong>${escape(title)}</strong></p><p>${escape(body)}</p>`;
}

/**
 * The dependencies the durable job uses. `actorUserId` is the person who
 * created the workspace or the organization. The binding records them as its
 * author.
 */
export function steeringRepoProvisionDeps(options: {
  actorUserId: string;
  env?: Readonly<Record<string, string | undefined>>;
}): ProvisionDeps {
  const app = steeringAppFromEnv(options.env ?? process.env);
  const loadedSlugs = new Map<string, string>();

  return {
    now: () => new Date(),

    async load(scope) {
      // tenancy: filtered by orgId from the provision event, which
      // create_workspace or create_organization sent after verified membership.
      const [org] = await withSystemDb((tx) =>
        tx
          .select({
            slug: schema.organizations.slug,
            settings: schema.organizations.settings,
          })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, scope.orgId))
          .limit(1),
      );
      if (!org) throw new Error(`organization ${scope.orgId} not found`);
      loadedSlugs.set(scope.orgId, org.slug);
      const stored = readSteeringConnection(org.settings);
      if (scope.kind === "organization")
        return {
          target: { org_slug: org.slug, workspace: null },
          state: readSteeringRepoState(org.settings),
          connection: stored,
        };
      // tenancy: filtered by workspaceId and orgId together, both from the
      // provision event create_workspace sent after verified membership.
      const [workspace] = await withSystemDb((tx) =>
        tx
          .select({
            slug: schema.workspaces.slug,
            name: schema.workspaces.name,
            settings: schema.workspaces.settings,
          })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.id, scope.workspaceId),
              eq(schema.workspaces.orgId, scope.orgId),
            ),
          )
          .limit(1),
      );
      if (!workspace)
        throw new SteeringProvisionBlockedError(
          "workspace_not_found",
          `Workspace ${scope.workspaceId} no longer exists.`,
        );
      const state = readSteeringRepoState(workspace.settings);
      return {
        target: {
          org_slug: org.slug,
          workspace: { slug: workspace.slug, name: workspace.name },
        },
        state,
        // The workspace's own choice comes first (#5196).
        connection: state?.connection ?? stored,
      };
    },

    saveState: saveSteeringRepoState,

    async saveConnection(scope, connection) {
      await saveSteeringConnection(scope.orgId, connection);
    },

    async keepConnection(scope, connection) {
      await keepSteeringConnection(scope.orgId, connection);
    },

    legacySteeringSource(scope) {
      return runInTenantScope(
        { orgId: scope.orgId, workspaceId: scope.workspaceId },
        () => readLegacySteeringSource(scope),
      );
    },

    github(scope) {
      if (app === null) return null;
      return {
        app: app.app,
        installation: (installationId) =>
          steeringInstallationRest(app, installationId),
        async user() {
          const [latest] = await storedTokens(
            scope.orgId,
            GITHUB_STEERING_PROVIDER,
          );
          return latest ? gh.createGithubRest({ token: latest.token }) : null;
        },
      };
    },

    gitlab(scope) {
      const clients = async () => {
        const byGroup = new Map<number, gl.GitlabRest>();
        for (const stored of await storedTokens(
          scope.orgId,
          GITLAB_STEERING_PROVIDER,
        )) {
          const id = Number(stored.provider_user_id);
          // Newest first, so the first token for a group wins.
          if (!Number.isInteger(id) || byGroup.has(id)) continue;
          byGroup.set(id, gl.createGitlabRest({ token: stored.token }));
        }
        return byGroup;
      };
      return {
        async groups() {
          const out: gl.SteeringGroup[] = [];
          for (const [id, rest] of await clients()) {
            const group = await gl.getGroup(rest, id);
            if (group !== null) out.push(group);
          }
          return out;
        },
        async group(groupId) {
          return (await clients()).get(groupId) ?? null;
        },
      };
    },

    async bind(scope, { connection, repository, default_branch }) {
      const now = new Date();
      const provider = connection.provider;
      const connectorId =
        provider === "github"
          ? GITHUB_STEERING_PROVIDER
          : GITLAB_STEERING_PROVIDER;
      const providerRepositoryId = String(repository.id);
      const tenant = { orgId: scope.orgId, workspaceId: scope.workspaceId };
      return runInTenantScope(tenant, () =>
        withTenantDb(async (tx) => {
          // The lock every writer of the workspace's heads takes, so a
          // concurrent writer cannot add a steering head between the check
          // below and this step's insert.
          await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
          // A steering head for another repository means an earlier run bound
          // a different steering repo. A second one would leave the readers
          // to pick between them, so the job stops for a person to decide.
          const steering = await tx
            .select({
              provider: schema.repositoryBindingHeads.provider,
              providerRepositoryId:
                schema.repositoryBindingHeads.providerRepositoryId,
            })
            .from(schema.repositoryBindingHeads)
            .where(
              and(
                eq(schema.repositoryBindingHeads.orgId, scope.orgId),
                eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
                eq(schema.repositoryBindingHeads.role, "steering"),
              ),
            );
          if (
            steering.some(
              (h) =>
                h.provider !== provider ||
                h.providerRepositoryId !== providerRepositoryId,
            )
          )
            throw new SteeringProvisionBlockedError(
              "steering_repo_already_bound",
              `Workspace ${scope.workspaceId} already has a steering repository, so this job does not bind ${repository.full_name} as a second one.`,
            );
          const [existing] = await tx
            .select({ id: schema.sourceConnections.id })
            .from(schema.sourceConnections)
            .where(
              and(
                eq(schema.sourceConnections.orgId, scope.orgId),
                eq(schema.sourceConnections.workspaceId, scope.workspaceId),
                eq(schema.sourceConnections.connectorId, connectorId),
                isNull(schema.sourceConnections.deletedAt),
              ),
            )
            .limit(1);
          let connectionId = existing?.id;
          if (connectionId === undefined) {
            const [inserted] = await tx
              .insert(schema.sourceConnections)
              .values({
                orgId: scope.orgId,
                workspaceId: scope.workspaceId,
                connectorId,
                displayName:
                  provider === "github" ? "GitHub steering" : "GitLab steering",
                authScheme:
                  provider === "github"
                    ? "github_app_installation"
                    : "group_access_token",
                deliveryMethod: "webhook",
                deliveryConfig:
                  connection.provider === "github"
                    ? {
                        installationId: connection.installation_id,
                        owner: connection.account_login,
                      }
                    : {
                        groupId: connection.group_id,
                        groupPath: connection.group_path,
                      },
                status: "connected",
                createdAt: now,
                updatedAt: now,
                createdById: options.actorUserId,
                updatedById: options.actorUserId,
              })
              .returning({ id: schema.sourceConnections.id });
            if (!inserted)
              throw new Error("source_connections insert returned no row");
            connectionId = inserted.id;
          }
          const [head] = await tx
            .select({ publicId: schema.repositoryBindings.publicId })
            .from(schema.repositoryBindingHeads)
            .innerJoin(
              schema.repositoryBindings,
              eq(
                schema.repositoryBindings.id,
                schema.repositoryBindingHeads.currentBindingId,
              ),
            )
            .where(
              and(
                eq(schema.repositoryBindingHeads.connectionId, connectionId),
                eq(
                  schema.repositoryBindingHeads.providerRepositoryId,
                  providerRepositoryId,
                ),
              ),
            )
            .limit(1);
          if (head) return head.publicId;
          const written = await writeRepositoryHead(tx, {
            scope: tenant,
            connectionId,
            repo: {
              id: providerRepositoryId,
              owner: repository.owner,
              name: repository.name,
              fullName: repository.full_name,
              defaultBranch: default_branch,
            },
            role: "steering",
            provider,
            userId: options.actorUserId,
            now,
          });
          return written.bindingPublicId;
        }),
      );
    },

    async notifyReauthorize(scope, provider) {
      const { notifyOrgManagers } = await import("@oxagen/notifications");
      const slug = loadedSlugs.get(scope.orgId) ?? "";
      const title =
        provider === "github"
          ? "Authorize the Oxagen GitHub App again"
          : "Connect your GitLab group again";
      const body =
        provider === "github"
          ? "Oxagen could not finish setting up a steering repo because its GitHub authorization is missing or GitHub refused it. An organization owner must authorize the Oxagen GitHub App again."
          : "Oxagen could not finish setting up a steering repo because the GitLab group token is missing or GitLab refused it. An organization owner must connect the group again.";
      const deepLink = `/${slug}`;
      await notifyOrgManagers({
        orgId: scope.orgId,
        ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {}),
        kind: "security",
        title,
        body,
        deepLink,
        emailHtml: reauthorizeEmail(title, body),
      });
    },

    steeringHook: (scope, projectId) =>
      steeringHookTarget(
        { kind: scope.kind, scopeId: scopeId(scope), projectId },
        options.env ?? process.env,
      ),

    // The repository sync's publish port with the sync's production deps, so
    // the first version lands in the same store, under the same key, with the
    // same tool projection as every later one (#4732). Loaded on the call, as
    // the sync's modules are, and run in the workspace's tenant scope the
    // sync runs in.
    async publishFirst(scope) {
      const [
        { steeringSyncPublish },
        { createSteeringHost },
        { withToolProjection },
        { readSteeringHealth },
      ] = await Promise.all([
        import("./steering-repo/publisher"),
        import("./context.steering.host"),
        import("./mcp-studio/publish-deps"),
        import("./steering-repo/health.read"),
      ]);
      const publish = steeringSyncPublish({
        host: createSteeringHost(),
        extend: withToolProjection,
        readHealth: readSteeringHealth,
      });
      return runInTenantScope(
        { orgId: scope.orgId, workspaceId: scope.workspaceId },
        () => publish(scope),
      );
    },

    // The run migrate_tools_to_steering runs, with no person behind it, in
    // the workspace's tenant scope (ADR-245). Loaded on the call, so a
    // provision that never reaches ready loads none of it.
    async startToolMigration(scope) {
      const [{ runToolMigration }, { toolMigrationDeps }] = await Promise.all([
        import("./mcp-studio/migration-run"),
        import("./mcp-studio/migration-deps"),
      ]);
      const workspace = { orgId: scope.orgId, workspaceId: scope.workspaceId };
      const result = await runInTenantScope(
        {
          ...workspace,
          principalKind: "service",
          capabilityName: "migrate_tools_to_steering",
        },
        () =>
          runToolMigration(workspace, { actorUserId: null }, toolMigrationDeps()),
      );
      logger.info(
        {
          ...workspace,
          state: result.state,
          pullRequests: result.pullRequests.map((pr) => pr.number),
        },
        "steering_repo.provision: started the move of the workspace's MCP servers into its steering repo",
      );
    },

    // The same write as the app's "Use this installation" button, in the
    // workspace's tenant scope, attributed to the person who created the
    // workspace. The job runs its steps outside any tenant scope. The check
    // comes first because the attach replaces the installation id on an
    // existing `github` connection, and a rerun of this step must never
    // replace an installation a person chose.
    async attachCodeInstallation(scope, installationId) {
      const workspace = { orgId: scope.orgId, workspaceId: scope.workspaceId };
      await runInTenantScope(workspace, async () => {
        if ((await resolveWorkspaceGithubInstallation(workspace)) !== null)
          return;
        const { publicId } = await attachWorkspaceGithubInstallation({
          ...workspace,
          installationId: String(installationId),
          actingUserId: options.actorUserId,
        });
        logger.info(
          { ...workspace, connectionId: publicId, installationId },
          "steering_repo.provision: attached the steering installation as the workspace's GitHub connection",
        );
      });
    },
  };
}

/**
 * What the provision event carries. A type alias, not an interface, so it
 * fits the event client's `Record<string, unknown>` data.
 */
export type SteeringRepoProvisionRequest = {
  orgId: string;
  /** Null for the organization repository. */
  workspaceId: string | null;
  /** The person who created the workspace or the organization. */
  actorUserId: string;
};

const loadEventClient = () => import("./event-client");

/**
 * The event client, imported on the first send. create_org starts two sends
 * at once, and both wait on this one import. Two concurrent imports of a
 * mocked module can resolve to different copies under vitest. A failed import
 * is dropped, so the next send tries again.
 */
let eventClientImport: ReturnType<typeof loadEventClient> | undefined;

/** Start the durable job, or resume it from the step that stopped. */
export async function requestSteeringRepoProvision(
  data: SteeringRepoProvisionRequest,
): Promise<void> {
  eventClientImport ??= loadEventClient().catch((err: unknown) => {
    eventClientImport = undefined;
    throw err;
  });
  const { eventClient } = await eventClientImport;
  await eventClient.send({
    name: "steering-repo/provision.requested",
    data,
  });
}

/**
 * Send the provision event for a scope whose `steering_repo` setting already
 * holds `state`. The workspace or organization exists whether or not the job
 * starts. When the send fails, this records the state as failed with the code
 * `enqueue_failed`, so the page says so and sending the event again resumes
 * it. It never throws, and it returns the status the setting now holds.
 */
export async function startSteeringRepoProvision(
  request: SteeringRepoProvisionRequest,
  state: SteeringRepoState,
  send: (
    data: SteeringRepoProvisionRequest,
  ) => Promise<void> = requestSteeringRepoProvision,
): Promise<SteeringRepoStatus> {
  try {
    await send(request);
    return state.status;
  } catch (err) {
    logger.error(
      { err, orgId: request.orgId, workspaceId: request.workspaceId },
      "steering_repo.provision: could not queue the provision job",
    );
    const scope: SteeringRepoScope =
      request.workspaceId === null
        ? { kind: "organization", orgId: request.orgId }
        : {
            kind: "workspace",
            orgId: request.orgId,
            workspaceId: request.workspaceId,
          };
    await saveSteeringRepoState(scope, {
      ...state,
      status: "failed",
      error: {
        code: "enqueue_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      updated_at: new Date().toISOString(),
    }).catch((saveErr: unknown) => {
      logger.error(
        {
          err: saveErr,
          orgId: request.orgId,
          workspaceId: request.workspaceId,
        },
        "steering_repo.provision: could not record the failed provision request",
      );
    });
    return "failed";
  }
}
