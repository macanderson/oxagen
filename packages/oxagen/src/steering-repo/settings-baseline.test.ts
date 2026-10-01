import { describe, expect, it } from "vitest";
import { STEERING_DEFAULT_BRANCH } from "./names";
import {
  GITHUB_SETTINGS_BASELINE,
  GITLAB_SETTINGS_BASELINE,
  OXAGEN_STEERING_APP,
} from "./settings-baseline";

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

  it("requires no paid GitHub rulesets or environments", () => {
    expect(GITHUB_SETTINGS_BASELINE.rulesets).toEqual({});
    expect(GITHUB_SETTINGS_BASELINE.environments).toEqual({});
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
});

describe("GITLAB_SETTINGS_BASELINE", () => {
  it("protects main, squashes merge requests, resets approvals on push, and turns CI off", () => {
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
        reset_approvals_on_push: true,
        required_status: "Oxagen steering",
      },
      ci_cd: { builds_access_level: "disabled" },
    });
  });
});
