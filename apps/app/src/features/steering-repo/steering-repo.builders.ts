// Test builders for the steering repo lane (#4518): one steering repo view in
// each state the card, the provisioning list, and the health banner draw.
// Every builder starts from a repo that finished provisioning and reads
// healthy, and a test overrides only what it is about.
import {
  type SettingsDifferenceView,
  STEERING_REPO_STEPS,
  type SteeringRepoStep,
  type SteeringRepoView,
} from "./types";

export const GITHUB_REPOSITORY = {
  fullName: "acme/oxagen-core-platform",
  url: "https://github.com/acme/oxagen-core-platform",
};

export const GITLAB_REPOSITORY = {
  fullName: "acme/steering/oxagen-core-platform",
  url: "https://gitlab.com/acme/steering/oxagen-core-platform",
};

/** A steering repo that finished provisioning on GitHub and reads healthy. */
export function steeringRepoView(
  overrides: Partial<SteeringRepoView> = {},
): SteeringRepoView {
  return {
    status: "ready",
    step: "bind_repository",
    failedStep: null,
    error: null,
    provider: "github",
    repository: GITHUB_REPOSITORY,
    publishedVersion: 3,
    health: "healthy",
    differences: [],
    ...overrides,
  };
}

/**
 * A steering repo whose job failed at `failedStep` with `error`, after every
 * step before it finished. It has no repository, version, or health yet.
 */
export function failedSteeringRepo(
  failedStep: SteeringRepoStep,
  error: { code: string; message: string },
  overrides: Partial<SteeringRepoView> = {},
): SteeringRepoView {
  return steeringRepoView({
    status: "failed",
    step:
      STEERING_REPO_STEPS[STEERING_REPO_STEPS.indexOf(failedStep) - 1] ?? null,
    failedStep,
    error,
    repository: null,
    publishedVersion: null,
    health: null,
    ...overrides,
  });
}

/** One prescribed setting that differs, changed by a named person. */
export function settingsDifference(
  overrides: Partial<SettingsDifferenceView> = {},
): SettingsDifferenceView {
  return {
    setting: "rulesets.oxagen_merges",
    expected: "active",
    actual: "disabled",
    changedBy: "jordan-lee",
    changedAt: "2026-09-26T14:05:00.000Z",
    ...overrides,
  };
}
