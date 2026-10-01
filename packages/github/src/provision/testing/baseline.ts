// baseline.ts: a fixture covering every supported GitHub settings operation.
// It includes paid features for adapter tests. Production steering settings
// come from GITHUB_SETTINGS_BASELINE in @oxagen/oxagen.
import type { SteeringGithubSettings } from "../types";

export const EXAMPLE_GITHUB_BASELINE: SteeringGithubSettings = {
  visibility: "private",
  default_branch: "main",
  rulesets: {
    oxagen_steering: {
      name: "Oxagen steering",
      target: "branch",
      enforcement: "active",
      include: ["refs/heads/main"],
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
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: [
              { context: "Oxagen steering", integration: "oxagen-steering" },
            ],
          },
        },
        { type: "non_fast_forward" },
        { type: "deletion" },
        { type: "required_linear_history" },
      ],
    },
    oxagen_merges: {
      name: "Oxagen merges",
      target: "branch",
      enforcement: "active",
      include: ["refs/heads/main"],
      bypass_actors: [{ actor: "oxagen-steering", bypass_mode: "always" }],
      rules: [
        {
          type: "update",
          parameters: { update_allows_fetch_and_merge: false },
        },
      ],
    },
  },
  merge: {
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
  },
  actions: { enabled: false },
  environments: {
    steering: {
      deployment_branches: ["main"],
      deployed_by: "oxagen-steering",
    },
  },
};
