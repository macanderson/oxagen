// index.ts: the GitLab half of steering repo provisioning.
//
// Each helper does one idempotent step. The provisioning job runs them in
// order and retries a step that throws.
export type * from "./types";
export { GitLabApiError } from "../client";
export {
  createGitlabRest,
  GitLabRateLimitedError,
  RATE_LIMIT_RETRY_MS,
  seg,
  SteeringGitlabReauthorizeError,
} from "./http";
export type {
  GitlabResponse,
  GitlabRest,
  GitlabRestOptions,
  HttpFetch,
} from "./http";
export {
  candidateName,
  createOrAdoptProject,
  createProject,
  getCurrentUser,
  getGroup,
  getProject,
} from "./project";
export type {
  CreateOrAdoptProjectInput,
  CreateProjectResult,
  FoundProject,
} from "./project";
export { STEERING_BRANCH, writeFirstCommit } from "./first-commit";
export {
  applyGitlabSettings,
  compareGitlabSettings,
  readGitlabSettings,
} from "./settings";
export { recordGitlabDeployment } from "./deployment";
