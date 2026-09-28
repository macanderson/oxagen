// The steering repo as the web app shows it (steering-repo-spec, Provisioning
// and Settings drift). The app may import platform code only through
// `@oxagen/oxagen/contracts/*` (INV-03), so the step list and the health states
// mirror packages/handlers/src/steering_repo.provision.ts and
// packages/oxagen/src/steering-repo/health.ts. `types.test.ts` pins the copies.

/** The provisioning steps, in the order the job runs them. */
export const STEERING_REPO_STEPS = [
  "pick_connection",
  "create_repository",
  "add_to_installation",
  "write_first_commit",
  "apply_settings",
  "publish_version",
  "bind_repository",
] as const;
export type SteeringRepoStep = (typeof STEERING_REPO_STEPS)[number];

type SteeringRepoStatus = "provisioning" | "ready" | "failed" | "blocked";

/** The error code of a step that needs an owner to authorize Oxagen Steering again. */
export const STEERING_REAUTHORIZE = "steering_reauthorize";

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
};

/**
 * What the steering repo read answers. `not_backed` names the capability the
 * read needs while no lane has registered it: the page says so, and no kernel
 * call is made, because an unregistered call reports to error tracking.
 */
export type SteeringRepoRead =
  | { kind: "ok"; view: SteeringRepoView }
  | { kind: "not_backed"; capability: string };
