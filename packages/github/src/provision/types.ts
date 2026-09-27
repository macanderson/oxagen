// types.ts: the shapes steering repo provisioning reads and writes.
//
// `SteeringGithubSettings` mirrors `GithubSettings` in
// @oxagen/oxagen/steering-repo (settings-baseline.ts). This package does not
// depend on @oxagen/oxagen, so the caller passes the baseline in and the
// compiler checks the two shapes against each other at the call site.

/** An app or bot named by a symbol, such as `oxagen-steering`. */
export type AppSymbol = string;

export type SteeringRulesetRule =
  | {
      type: "pull_request";
      parameters: {
        required_approving_review_count: number;
        dismiss_stale_reviews_on_push: boolean;
        require_code_owner_review: boolean;
        require_last_push_approval: boolean;
        required_review_thread_resolution: boolean;
        allowed_merge_methods: readonly ("merge" | "squash" | "rebase")[];
      };
    }
  | {
      type: "required_status_checks";
      parameters: {
        strict_required_status_checks_policy: boolean;
        do_not_enforce_on_create: boolean;
        required_status_checks: readonly {
          context: string;
          integration: AppSymbol;
        }[];
      };
    }
  | { type: "non_fast_forward" }
  | { type: "deletion" }
  | { type: "required_linear_history" }
  | { type: "update"; parameters: { update_allows_fetch_and_merge: boolean } };

export interface SteeringRuleset {
  name: string;
  target: "branch";
  enforcement: "active";
  include: readonly string[];
  bypass_actors: readonly { actor: AppSymbol; bypass_mode: "always" }[];
  rules: readonly SteeringRulesetRule[];
}

export interface SteeringGithubSettings {
  visibility: "private" | "internal" | "public";
  default_branch: string;
  rulesets: Readonly<Record<string, SteeringRuleset>>;
  merge: {
    allow_squash_merge: boolean;
    allow_merge_commit: boolean;
    allow_rebase_merge: boolean;
    delete_branch_on_merge: boolean;
  };
  actions: { enabled: boolean };
  environments: Readonly<
    Record<
      string,
      { deployment_branches: readonly string[]; deployed_by: AppSymbol }
    >
  >;
}

/**
 * What a read of a repository's settings found. Unknown actors and rules keep
 * GitHub's own names, so a comparison reports them as they are.
 */
export interface ObservedRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  include: string[];
  bypass_actors: { actor: string; bypass_mode: string }[];
  rules: { type: string; parameters?: Record<string, unknown> }[];
}

export interface ObservedGithubSettings {
  visibility: string;
  default_branch: string;
  /** Keyed by the ruleset's name in snake_case, such as `oxagen_steering`. */
  rulesets: Record<string, ObservedRuleset>;
  merge: {
    allow_squash_merge: boolean;
    allow_merge_commit: boolean;
    allow_rebase_merge: boolean;
    delete_branch_on_merge: boolean;
  };
  actions: { enabled: boolean };
  environments: Record<
    string,
    {
      deployment_branches: string[];
      /** Who recorded the latest deployment, or null before the first. */
      deployed_by: string | null;
    }
  >;
}

/** One setting that differs from the baseline. */
export interface SettingDifference {
  /** A dotted path, such as `merge.allow_rebase_merge`. */
  setting: string;
  expected: unknown;
  actual: unknown;
}

/** The GitHub App that acts on steering repos, as the API names it. */
export interface SteeringApp {
  /** The symbol the baseline uses for it. */
  symbol: AppSymbol;
  /** The app's numeric id. Rulesets name an app by it. */
  id: number;
  /** The app's slug. A deployment names the app that recorded it by it. */
  slug: string;
}

/** The address of one repository. */
export interface RepoAddress {
  owner: string;
  name: string;
}

/** A repository as provisioning records it. */
export interface ProvisionedRepository {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
}

/** One file of the first commit. */
export interface SeedFile {
  path: string;
  content: string;
}
