// types.ts: the shapes steering repo provisioning on GitLab reads and writes.
//
// `SteeringGitlabSettings` mirrors `GitlabSettings` in
// @oxagen/oxagen/steering-repo (settings-baseline.ts). This package does not
// depend on @oxagen/oxagen, so the caller passes the baseline in and the
// compiler checks the two shapes against each other at the call site.

/**
 * The bot user of the group access token that acts on steering repos. The
 * baseline names it by a symbol, `oxagen-steering`, because its user id
 * differs per group and per GitLab instance.
 */
export interface SteeringBot {
  /** The symbol the baseline uses for it. */
  symbol: string;
  user_id: number;
  username: string;
}

/** The GitLab group that holds the steering repos. */
export interface SteeringGroup {
  id: number;
  /** Such as `acme` or `acme/platform`. */
  full_path: string;
}

/** A project as provisioning records it. */
export interface ProvisionedProject {
  id: number;
  /** Such as `acme/oxagen-support`. */
  path_with_namespace: string;
  /** The full path of the group that holds it, such as `acme`. */
  namespace_path: string;
  /** The project's path, which provisioning sets equal to its name. */
  name: string;
  default_branch: string;
}

/** One file of the first commit. */
export interface SeedFile {
  path: string;
  content: string;
}

/** One setting that differs from the baseline. */
export interface SettingDifference {
  /** A dotted path, such as `protected_branches.main.push_access`. */
  setting: string;
  expected: unknown;
  actual: unknown;
}

/** One protected branch, as the baseline holds it. */
export interface SteeringProtectedBranch {
  push_access: "no_one";
  /** The symbol of the only user allowed to merge. */
  merge_access: string;
  allow_force_push: boolean;
}

/** Every GitLab setting Oxagen holds on a steering repo. */
export interface SteeringGitlabSettings {
  visibility: "private" | "internal" | "public";
  default_branch: string;
  protected_branches: Readonly<Record<string, SteeringProtectedBranch>>;
  merge_requests: {
    squash_option: "always" | "default_on" | "default_off" | "never";
    only_allow_merge_if_pipeline_succeeds: boolean;
    remove_source_branch_after_merge: boolean;
    /**
     * GitLab drops every approval when a commit is pushed to the merge
     * request. An approval then always approves the head it was given on,
     * which the merge queue relies on. The setting needs GitLab Premium.
     */
    reset_approvals_on_push: boolean;
    /** The external commit status that satisfies "pipelines must succeed". */
    required_status: string;
  };
  ci_cd: { builds_access_level: "disabled" | "private" | "enabled" };
}

/**
 * One protected branch as a read found it. Each access list reads as its
 * symbols, sorted and joined with ", ": `no_one`, `developers`, `maintainers`,
 * `admins`, `level:<n>`, `user:<id>`, `group:<id>`, `deploy_key:<id>`, or the
 * bot's symbol. A list of one entry reads exactly like the baseline value.
 */
export interface ObservedProtectedBranch {
  push_access: string;
  merge_access: string;
  allow_force_push: boolean;
}

/** What a read of a project's settings found. */
export interface ObservedGitlabSettings {
  visibility: string;
  default_branch: string | null;
  /** Every protected branch, keyed by its name or wildcard. */
  protected_branches: Record<string, ObservedProtectedBranch>;
  merge_requests: {
    squash_option: string;
    only_allow_merge_if_pipeline_succeeds: boolean;
    remove_source_branch_after_merge: boolean;
    /** Null when GitLab would not say, as on a tier without approval settings. */
    reset_approvals_on_push: boolean | null;
  };
  ci_cd: { builds_access_level: string };
}
