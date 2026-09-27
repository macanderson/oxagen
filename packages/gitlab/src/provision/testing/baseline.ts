// baseline.ts: the GitLab settings baseline, as tests use it.
//
// This package does not depend on @oxagen/oxagen, so this file repeats the
// values of GITLAB_SETTINGS_BASELINE in settings-baseline.ts. A test that
// needs the real baseline imports it from @oxagen/oxagen instead.
import type { SteeringGitlabSettings } from "../types";

export const EXAMPLE_GITLAB_BASELINE: SteeringGitlabSettings = {
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
};
