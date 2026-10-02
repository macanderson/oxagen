// The steering repo as the web app shows it (steering-repo-spec, Provisioning
// and Settings drift). The app may import platform code only through
// `@oxagen/oxagen/contracts/*` (INV-03), so the step list and the health states
// mirror packages/handlers/src/steering_repo.provision.ts and
// packages/oxagen/src/steering-repo/health.ts. `types.test.ts` pins the copies.
// `SteeringRepoView` is the app's name for what `get_steering_repo` answers:
// ./read assigns the port's record to it, so the compiler checks the two agree.
import type { SteeringImportRunView } from "@oxagen/oxagen/contracts/steering_repo.get";
import type { Read } from "@/data/read";

/** The provisioning steps, in the order the job runs them. */
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

/**
 * `not_started` is a workspace that never recorded a setup: one made before
 * steering repos existed (#4875). The job's own states follow.
 */
type SteeringRepoStatus =
  | "not_started"
  | "provisioning"
  | "ready"
  | "failed"
  | "blocked";

/** The error code of a step that needs an owner to authorize Oxagen again. */
export const STEERING_REAUTHORIZE = "steering_reauthorize";

/** The error code of a setup that waits on a person to pick its connection. */
export const STEERING_CHOOSE_CONNECTION = "choose_connection";

/**
 * The import's refusal for a workspace that reads its repository through a
 * retired sources connection. It goes on only with `startFresh`.
 */
export const STEERING_IMPORT_LEGACY_CONNECTION =
  "steering_import_legacy_connection";

/** The error code of a setup that found no GitHub organization or GitLab group. */
export const STEERING_NO_CONNECTION = "no_connection";

/**
 * The error code of a name the workspace chose that a repository Oxagen did
 * not create already holds (#5196). A retry with another name goes on.
 */
export const STEERING_REPOSITORY_NAME_TAKEN = "repository_name_taken";

/**
 * The error code of a place the workspace chose that the organization's stored
 * tokens no longer reach (#5196). A retry with another place goes on.
 */
export const STEERING_UNKNOWN_CONNECTION = "unknown_connection";

/**
 * The error code of a create the host refused for a reason other than a taken
 * name, such as an organization policy (#4899). Another place may take it.
 */
export const STEERING_REPOSITORY_CREATE_REFUSED = "repository_create_refused";

/**
 * @internal Exported for types.test.ts, which pins it to the job's code.
 * The error code of a workspace still steered by a code repository. The
 * setup reads `legacySource` for it and goes on through the import.
 */
export const STEERING_IMPORT_REQUIRED = "steering_import_required";

/**
 * A GitHub organization, the owner's own personal GitHub account, or a GitLab
 * group that setup can create steering repos in.
 */
type SteeringConnectionChoice = {
  provider: "github" | "gitlab";
  /** The GitHub installation id or the GitLab group id. */
  id: number;
  /** The organization's or account's login, or the group's path. */
  name: string;
  /** `user` for a personal GitHub account (#4899). */
  kind: "organization" | "user";
};

/** The connection a person picks, by provider and id. */
export type SteeringConnectionPick = Pick<
  SteeringConnectionChoice,
  "provider" | "id"
>;

/**
 * @internal Exported for types.test.ts, which pins it to the platform's list.
 * The app uses it only for `RepoHealth`.
 */
export const REPO_HEALTH_STATES = [
  "healthy",
  "drifted",
  "disconnected",
  "diverged",
] as const;
export type RepoHealth = (typeof REPO_HEALTH_STATES)[number];

/** One prescribed setting that differs, as the banner lists it. */
export type SettingsDifferenceView = {
  /** The setting's path in the baseline, such as `rulesets.oxagen_merges`. */
  setting: string;
  /** The prescribed value, rendered as text. */
  expected: string;
  /** The value the host reports, rendered as text. */
  actual: string;
  changedBy: string | null;
  /** ISO 8601. */
  changedAt: string | null;
};

/** A workspace's steering repo: its provisioning, its link, its version, and its health. */
export type SteeringRepoView = {
  status: SteeringRepoStatus;
  /** The last step that finished, or null before the first. */
  step: SteeringRepoStep | null;
  /** The step that failed or stopped, or null. */
  failedStep: SteeringRepoStep | null;
  error: { code: string; message: string } | null;
  provider: "github" | "gitlab" | null;
  /** Null until `create_repository` finishes. */
  repository: { fullName: string; url: string } | null;
  /** The published version, or null before `publish_version` finishes. */
  publishedVersion: number | null;
  /** Null while provisioning, before the first health read. */
  health: RepoHealth | null;
  differences: readonly SettingsDifferenceView[];
  /**
   * The code repository that still steers the workspace through its
   * `.oxagen/` tree, or null. Setup for such a workspace runs the import,
   * which reads only a GitHub repository.
   */
  legacySource: {
    fullName: string;
    url: string;
    provider: "github" | "gitlab";
  } | null;
  /**
   * Where this workspace's steering repo goes: the place the workspace chose
   * when it was created, else the organization's stored one, or null before
   * either is set (#5196). An owner can reset the organization's until
   * Oxagen has created a repo there.
   */
  connection: SteeringConnectionChoice | null;
  /**
   * The name the workspace chose for its steering repo, which Oxagen creates
   * exactly, or null for `oxagen-<slug>`.
   */
  requestedName: string | null;
  /** The connections to pick from when setup stopped with `choose_connection`. */
  connectionChoices: readonly SteeringConnectionChoice[];
  /** The workspace's last `import_workspace_steering` run, or null. See `pendingMove`. */
  importRun: SteeringImportRunView | null;
};

/**
 * The repository whose `.oxagen/` tree a stopped import has yet to move, or
 * null (#5082). The import's demote step stops that repository steering, so
 * from then on `legacySource` reads null and only the run's own state says
 * the move is unfinished, even once the steering repo is ready. Calling
 * `import_workspace_steering` again resumes the run at the step that stopped.
 */
export function pendingMove(
  view: SteeringRepoView,
): { fullName: string; url: string } | null {
  const run = view.importRun;
  if (run === null || run.status === "done" || run.step === null) return null;
  return run.source;
}

/**
 * What the steering repo read answers: the view, or the failed `Read` that
 * `get_steering_repo` returned (denied, pending approval, or an error). The
 * card and onboarding draw the failure with `ReadFailure`. The health banner
 * draws nothing.
 */
export type SteeringRepoRead =
  | { kind: "ok"; view: SteeringRepoView }
  | { kind: "failed"; failure: Exclude<Read<unknown>, { ok: true }> };
