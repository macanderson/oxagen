import { describe, expect, it } from "vitest";
import {
  REQUIRED_CHECK_NAME,
  STEERING_DEFAULT_BRANCH,
  STEERING_ENVIRONMENT,
} from "./names";
import {
  GITHUB_SETTINGS_BASELINE,
  type GithubRulesetRule,
  GITLAB_SETTINGS_BASELINE,
  OXAGEN_STEERING_APP,
} from "./settings-baseline";

const { oxagen_steering: steering, oxagen_merges: merges } =
  GITHUB_SETTINGS_BASELINE.rulesets;

function ruleOf<K extends GithubRulesetRule["type"]>(
  rules: readonly GithubRulesetRule[] | undefined,
  type: K,
): Extract<GithubRulesetRule, { type: K }> | undefined {
  return rules?.find(
    (rule): rule is Extract<GithubRulesetRule, { type: K }> =>
      rule.type === type,
  );
}

describe("OXAGEN_STEERING_APP", () => {
  it("names the app by its symbol", () => {
    expect(OXAGEN_STEERING_APP).toBe("oxagen-steering");
  });
});

describe("GITHUB_SETTINGS_BASELINE", () => {
  it("keeps a steering repo private on main", () => {
    expect(STEERING_DEFAULT_BRANCH).toBe("main");
    expect(GITHUB_SETTINGS_BASELINE.visibility).toBe("private");
    expect(GITHUB_SETTINGS_BASELINE.default_branch).toBe("main");
  });

  it("holds exactly the two rulesets, both active on main", () => {
    expect(Object.keys(GITHUB_SETTINGS_BASELINE.rulesets).sort()).toEqual([
      "oxagen_merges",
      "oxagen_steering",
    ]);
    for (const ruleset of [steering, merges]) {
      expect(ruleset?.target).toBe("branch");
      expect(ruleset?.enforcement).toBe("active");
      expect(ruleset?.include).toEqual(["refs/heads/main"]);
    }
    expect(steering?.name).toBe("Oxagen steering");
    expect(merges?.name).toBe("Oxagen merges");
  });

  it("lets nobody bypass the steering ruleset", () => {
    expect(steering?.bypass_actors).toEqual([]);
    expect(steering?.rules.map((rule) => rule.type)).toEqual([
      "pull_request",
      "required_status_checks",
      "non_fast_forward",
      "deletion",
      "required_linear_history",
    ]);
  });

  it("requires no host approval and allows only squash", () => {
    expect(ruleOf(steering?.rules, "pull_request")?.parameters).toEqual({
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: false,
      allowed_merge_methods: ["squash"],
    });
  });

  it("requires the one Oxagen check, posted by the Oxagen app", () => {
    expect(REQUIRED_CHECK_NAME).toBe("Oxagen steering");
    expect(
      ruleOf(steering?.rules, "required_status_checks")?.parameters,
    ).toEqual({
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: "Oxagen steering", integration: "oxagen-steering" },
      ],
    });
  });

  it("lets only the Oxagen app update main", () => {
    expect(merges?.bypass_actors).toEqual([
      { actor: "oxagen-steering", bypass_mode: "always" },
    ]);
    expect(merges?.rules).toEqual([
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
    ]);
  });

  it("merges by squash only and deletes the branch", () => {
    expect(GITHUB_SETTINGS_BASELINE.merge).toEqual({
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
    });
  });

  it("turns Actions off", () => {
    expect(GITHUB_SETTINGS_BASELINE.actions).toEqual({ enabled: false });
  });

  it("publishes to the steering environment from main, by the Oxagen app", () => {
    expect(STEERING_ENVIRONMENT).toBe("steering");
    expect(GITHUB_SETTINGS_BASELINE.environments).toEqual({
      steering: { deployment_branches: ["main"], deployed_by: "oxagen-steering" },
    });
  });
});

describe("GITLAB_SETTINGS_BASELINE", () => {
  it("protects main, squashes merge requests, and turns CI off", () => {
    expect(GITLAB_SETTINGS_BASELINE).toEqual({
      visibility: "private",
      default_branch: "main",
      protected_branches: {
        main: {
          push_access: "no_one",
          merge_access: "oxagen-steering",
          allow_force_push: false,
        },
      },
      merge_requests: {
        squash_option: "always",
        only_allow_merge_if_pipeline_succeeds: true,
        remove_source_branch_after_merge: true,
        required_status: "Oxagen steering",
      },
      ci_cd: { builds_access_level: "disabled" },
    });
  });
});
