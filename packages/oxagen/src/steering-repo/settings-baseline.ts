// settings-baseline.ts: the repository settings Oxagen prescribes for every
// steering repo and organization repo (steering-repo-spec, Prescribed
// settings), as data. Lane S1 applies it and reads it back. Lane S2 compares
// it with what the host reports, and a difference fails every pull request.
//
// The settings let Oxagen merge from the web app every time and keep anything
// else from reaching `main`. The one required check, Oxagen as the only
// merger, and CI off are decided. The rest of each table is proposed.
//
// The shapes follow the host APIs' own field names, so S1 sends them with
// little mapping. An app or bot is named by a symbol, `oxagen-steering`,
// because its numeric id differs per installation and per GitLab instance.
import { REQUIRED_CHECK_NAME, STEERING_DEFAULT_BRANCH, STEERING_ENVIRONMENT } from "./names";

/** The app that acts on steering repos: Oxagen Steering on GitHub, its bot user on GitLab. */
export const OXAGEN_STEERING_APP = "oxagen-steering";
export type OxagenSteeringApp = typeof OXAGEN_STEERING_APP;

// ── GitHub ───────────────────────────────────────────────────────────────────

/** One rule in a GitHub repository ruleset, in the REST API's shape. */
export type GithubRulesetRule =
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
          /** The app that must post the check. S1 sends its app id. */
          integration: OxagenSteeringApp;
        }[];
      };
    }
  | { type: "non_fast_forward" }
  | { type: "deletion" }
  | { type: "required_linear_history" }
  | { type: "update"; parameters: { update_allows_fetch_and_merge: boolean } };

/** A GitHub repository ruleset on the default branch. */
export interface GithubRuleset {
  name: string;
  target: "branch";
  enforcement: "active";
  /** The branches it covers, as ref names. */
  include: readonly string[];
  /** Who may bypass it. S1 sends each app's id with actor_type Integration. */
  bypass_actors: readonly { actor: OxagenSteeringApp; bypass_mode: "always" }[];
  rules: readonly GithubRulesetRule[];
}

/** Every GitHub setting Oxagen holds on a steering repo. */
export interface GithubSettings {
  visibility: "private" | "internal" | "public";
  default_branch: string;
  /** Keyed by a snake_case id: `oxagen_steering` and `oxagen_merges`. */
  rulesets: Readonly<Record<string, GithubRuleset>>;
  merge: {
    allow_squash_merge: boolean;
    allow_merge_commit: boolean;
    allow_rebase_merge: boolean;
    delete_branch_on_merge: boolean;
  };
  actions: { enabled: boolean };
  environments: Readonly<
    Record<string, { deployment_branches: readonly string[]; deployed_by: OxagenSteeringApp }>
  >;
}

const MAIN_REF = `refs/heads/${STEERING_DEFAULT_BRANCH}`;

export const GITHUB_SETTINGS_BASELINE: GithubSettings = {
  // Steering holds business rules.
  visibility: "private",
  // Oxagen publishes from main.
  default_branch: STEERING_DEFAULT_BRANCH,
  rulesets: {
    // Approvals are counted by Oxagen's check, which knows the governance mode
    // and the reviewer groups, so the host requires none. Pinning the check to
    // the app stops anyone else posting it. No bypass.
    oxagen_steering: {
      name: "Oxagen steering",
      target: "branch",
      enforcement: "active",
      include: [MAIN_REF],
      bypass_actors: [],
      rules: [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
            allowed_merge_methods: ["squash"],
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            // Oxagen's merge queue brings each branch up to date itself.
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: [
              { context: REQUIRED_CHECK_NAME, integration: OXAGEN_STEERING_APP },
            ],
          },
        },
        { type: "non_fast_forward" },
        { type: "deletion" },
        { type: "required_linear_history" },
      ],
    },
    // Only Oxagen can update main, so nothing reaches it without passing the
    // check. Bypass is per ruleset, so the ruleset above still binds Oxagen.
    oxagen_merges: {
      name: "Oxagen merges",
      target: "branch",
      enforcement: "active",
      include: [MAIN_REF],
      bypass_actors: [{ actor: OXAGEN_STEERING_APP, bypass_mode: "always" }],
      rules: [
        { type: "update", parameters: { update_allows_fetch_and_merge: false } },
      ],
    },
  },
  merge: {
    // One commit per steering PR.
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    // Branches do not pile up.
    delete_branch_on_merge: true,
  },
  // Nothing in a steering repo runs code with its token. Oxagen runs every check.
  actions: { enabled: false },
  // The repository page shows the published version.
  environments: {
    [STEERING_ENVIRONMENT]: {
      deployment_branches: [STEERING_DEFAULT_BRANCH],
      deployed_by: OXAGEN_STEERING_APP,
    },
  },
};

// ── GitLab ───────────────────────────────────────────────────────────────────

/** Every GitLab setting Oxagen holds on a steering repo. */
export interface GitlabSettings {
  visibility: "private" | "internal" | "public";
  default_branch: string;
  protected_branches: Readonly<
    Record<
      string,
      {
        push_access: "no_one";
        merge_access: OxagenSteeringApp;
        allow_force_push: boolean;
      }
    >
  >;
  merge_requests: {
    squash_option: "always" | "default_on" | "default_off" | "never";
    only_allow_merge_if_pipeline_succeeds: boolean;
    remove_source_branch_after_merge: boolean;
    /** The external commit status that satisfies "pipelines must succeed". */
    required_status: string;
  };
  ci_cd: { builds_access_level: "disabled" | "private" | "enabled" };
}

export const GITLAB_SETTINGS_BASELINE: GitlabSettings = {
  visibility: "private",
  default_branch: STEERING_DEFAULT_BRANCH,
  protected_branches: {
    [STEERING_DEFAULT_BRANCH]: {
      push_access: "no_one",
      merge_access: OXAGEN_STEERING_APP,
      allow_force_push: false,
    },
  },
  merge_requests: {
    squash_option: "always",
    only_allow_merge_if_pipeline_succeeds: true,
    remove_source_branch_after_merge: true,
    required_status: REQUIRED_CHECK_NAME,
  },
  ci_cd: { builds_access_level: "disabled" },
};
