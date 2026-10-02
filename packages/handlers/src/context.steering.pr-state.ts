// context.steering.pr-state.ts — what the repository sync and
// refresh_steering_pr agree on when they move a steering PR to the host's state
// (ADR-184 decision 5): the statuses a moved head resets, the pending checks
// it resets to, and the wording of a close on the host. One copy, so a close
// the refresh records reads the same as one the sync records, and the
// steering PR page names both as a close on the host.
import {
  CHECK_NAMES,
  type CheckResult,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import type { SteeringRepository } from "./context.steering.github";

/** The statuses whose checks describe a head; a moved head resets them. */
export const STALE_FROM = [
  "checks_running",
  "checks_passed",
  "checks_failed",
] as const;

/** Every status of a steering PR still open on the host. */
export const OPEN_PR = ["pr_open", ...STALE_FROM] as const;

/** The six checks, pending, for a head nobody has checked yet. */
export const pendingChecks = (): CheckResult[] =>
  CHECK_NAMES.map((name) => ({
    name,
    status: "pending",
    summary: "",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
  }));

/** The host's name as a person reads it. */
export const hostName = (repo: Pick<SteeringRepository, "provider">) =>
  repo.provider === "gitlab" ? "GitLab" : "GitHub";

/** The reason recorded when the host closed a steering PR without merging it. */
export const closedOnHostReason = (
  repo: Pick<SteeringRepository, "provider">,
) => `Closed on ${hostName(repo)} without merging`;
