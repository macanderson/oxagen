// steering_repo.provision.ts: create, seed, and publish a steering repo
// (steering-repo-spec, Provisioning; lane S1, #4450).
//
// Creating a workspace creates its private steering repo `oxagen-<slug>`, and
// creating an organization creates `<org>/oxagen`. The durable job
// `steering-repo/provision` runs the steps below one at a time:
//
//   1. pick_connection      The organization's Oxagen Steering installation or
//                           GitLab group. Oxagen asks only when there is more
//                           than one.
//   2. create_repository    `oxagen-<slug>`, then `-2`, `-3` and so on.
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
//                           then the first commit published through the
//                           version store as version 1, so the first steering
//                           PR publishes version 2 (#4732).
//
// Every step is safe to repeat. The state lives in the `steering_repo` key of
// the workspace's settings, or of the organization's for `<org>/oxagen`, and
// records what each step made, so a rerun adopts it instead of making another.
// A failed step records its name and error, and the job retries from it.
import { decrypt, resolveIngestionCryptoAdapterForKeyId } from "@oxagen/crypto";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import {
  createAppInstallationToken,
  GitHubApiError,
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
  workspaceRepositoriesLock,
  writeRepositoryHead,
} from "./repository.binding-write";

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
  | { provider: "github"; installation_id: number; account_login: string }
  | { provider: "gitlab"; group_id: number; group_path: string };

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
  updated_at: string;
}

/** The state before the first step. */
export function initialSteeringRepoState(now: Date): SteeringRepoState {
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

/** The Oxagen Steering app's clients for one organization. */
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
  /** Null when the Oxagen Steering app is not configured. */
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
  if (ctx.connection !== null) {
    ctx.state.provider = ctx.connection.provider;
    return;
  }
  // A stored token that the host refuses stops this step with a reauthorize
  // banner for that host. The step does not skip the refused host and pick
  // the other one, because the saved choice is permanent and the owner may
  // have meant the host whose token lapsed.
  const candidates: SteeringConnection[] = [];
  const github = ctx.deps.github(ctx.scope);
  if (github !== null) {
    const user = await github.user();
    if (user !== null) {
      for (const installation of await gh.listSteeringInstallations(user)) {
        if (installation.account_type !== "Organization") continue;
        candidates.push({
          provider: "github",
          installation_id: installation.id,
          account_login: installation.account_login,
        });
      }
    }
  }
  for (const group of await ctx.deps.gitlab(ctx.scope).groups())
    candidates.push({
      provider: "gitlab",
      group_id: group.id,
      group_path: group.full_path,
    });

  const [only] = candidates;
  if (candidates.length > 1)
    throw new SteeringProvisionBlockedError(
      "choose_connection",
      `This organization has ${candidates.length} GitHub organizations and GitLab groups. Choose the one that holds steering repos, then retry.`,
    );
  if (only === undefined)
    throw new SteeringProvisionBlockedError(
      "no_connection",
      "This organization has no GitHub organization with Oxagen Steering installed and no GitLab group token. Connect one, then retry.",
    );
  await ctx.deps.saveConnection(ctx.scope, only);
  ctx.connection = only;
  ctx.state.provider = only.provider;
}

async function createRepositoryStep(ctx: StepContext): Promise<void> {
  if (ctx.state.repository !== null) return;
  const connection = requireConnection(ctx);
  const first_attempt = Math.max(1, ctx.state.attempt);
  const max_attempts =
    ctx.scope.kind === "organization" ? 1 : WORKSPACE_NAME_ATTEMPTS;
  const on_attempt = async (attempt: number, name: string) => {
    ctx.state.attempt = attempt;
    ctx.state.candidate = name;
    await save(ctx);
  };
  if (connection.provider === "github") {
    const github = requireGithub(ctx);
    const rest = await github.installation(connection.installation_id);
    const user = await github.user();
    let created: gh.CreateOrAdoptResult;
    try {
      created = await gh.createOrAdoptRepository(rest, {
        org: connection.account_login,
        base_name: baseName(ctx),
        description: describeRepository(ctx),
        marker: steeringRepoMarker(ctx.scope),
        first_attempt,
        max_attempts,
        // The app cannot see a repository outside its installation. The
        // owner's token can, so it looks a taken name up too.
        lookups: user === null ? [rest] : [rest, user],
        on_attempt,
      });
    } catch (err) {
      throw nameTaken(err);
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
      base_name: baseName(ctx),
      description: describeRepository(ctx),
      marker: steeringRepoMarker(ctx.scope),
      first_attempt,
      max_attempts,
      on_attempt,
    });
  } catch (err) {
    throw nameTaken(err);
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

/** Every name is taken by a repository this scope did not create. */
function nameTaken(err: unknown): unknown {
  const status =
    err instanceof GitHubApiError
      ? err.status
      : err instanceof gl.GitLabApiError
        ? err.status
        : null;
  if (status !== 422 && status !== 400) return err;
  return new SteeringProvisionBlockedError(
    "repository_name_taken",
    err instanceof Error ? err.message : String(err),
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
      "No organization owner has authorized Oxagen Steering. An owner must authorize it.",
    );
  const installation = (await gh.listSteeringInstallations(user)).find(
    (i) => i.id === connection.installation_id,
  );
  if (installation === undefined)
    throw new SteeringProvisionBlockedError(
      REAUTHORIZE,
      `The stored Oxagen Steering authorization cannot reach the installation on ${connection.account_login}. An owner must authorize it again.`,
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

async function bindRepository(ctx: StepContext): Promise<void> {
  if (ctx.scope.kind !== "workspace") return;
  const repository = requireRepository(ctx);
  ctx.state.binding_id = await ctx.deps.bind(ctx.scope, {
    connection: requireConnection(ctx),
    repository,
    default_branch: STEERING_DEFAULT_BRANCH,
  });
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
  return { ...initialSteeringRepoState(new Date(0)), ...state };
}

/** Read the connection a settings bag names, or null when it names none. */
export function readSteeringConnection(
  settings: unknown,
): SteeringConnection | null {
  const value = bagValue(settings, STEERING_CONNECTION_SETTING);
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

/** Mint an installation token for the Oxagen Steering app. */
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
      const connection = readSteeringConnection(org.settings);
      if (scope.kind === "organization")
        return {
          target: { org_slug: org.slug, workspace: null },
          state: readSteeringRepoState(org.settings),
          connection,
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
      return {
        target: {
          org_slug: org.slug,
          workspace: { slug: workspace.slug, name: workspace.name },
        },
        state: readSteeringRepoState(workspace.settings),
        connection,
      };
    },

    saveState: saveSteeringRepoState,

    async saveConnection(scope, connection) {
      const patch = { [STEERING_CONNECTION_SETTING]: connection };
      // tenancy: filtered by orgId from the provision event. The connection
      // is the one installation or group this org's own stored tokens reach.
      await withSystemDb((tx) =>
        tx
          .update(schema.organizations)
          .set({
            settings: mergeSettings(schema.organizations.settings, patch),
          })
          .where(eq(schema.organizations.id, scope.orgId)),
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
          ? "Authorize Oxagen Steering again"
          : "Connect your GitLab group again";
      const body =
        provider === "github"
          ? "Oxagen could not finish setting up a steering repo because the Oxagen Steering authorization is missing or GitHub refused it. An organization owner must authorize Oxagen Steering again."
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
