// context.steering.pr-state.ts — what the repository sync and
// refresh_context_pr agree on when they move a Context PR to the host's state
// (ADR-184 decision 5): the statuses a moved head resets, the pending checks
// it resets to, and the wording of a close on the host. One copy, so a close
// the refresh records reads the same as one the sync records, and the
// Context PR page names both as a close on the host.
import {
  CHECK_NAMES,
  isRecordKind,
  isSteeringPrKind,
  type CheckResult,
  type ProposalStatus,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import type { SteeringRepository } from "./context.steering.github";

/** The statuses whose checks describe a head; a moved head resets them. */
export const STALE_FROM = [
  "checks_running",
  "checks_passed",
  "checks_failed",
] as const;

/** Every status of a Context PR still open on the host. */
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

/**
 * Whether a head the host moved resets this proposal to `pr_open` at that
 * head. A record or governance proposal resets from the statuses whose checks
 * describe a head. A steering PR proposal also rests at `pr_open`, such as a
 * memory PR, which opens with no check, and its row still follows the head:
 * the merge refuses a head the row does not name (#5122).
 */
export function resetsOnMove(row: {
  kind: string;
  status: string;
}): row is { kind: string; status: ProposalStatus } {
  return (
    (STALE_FROM as readonly string[]).includes(row.status) ||
    (isSteeringPrKind(row.kind) && row.status === "pr_open")
  );
}

/**
 * The checks a moved head leaves on the row: the six record checks, pending,
 * for a record proposal. A governance or steering PR proposal runs the
 * steering checks, not the six, so it lists none (#4795, #5122).
 */
export const checksAfterMove = (kind: string): CheckResult[] =>
  isRecordKind(kind) ? pendingChecks() : [];

/** The host's name as a person reads it. */
export const hostName = (repo: Pick<SteeringRepository, "provider">) =>
  repo.provider === "gitlab" ? "GitLab" : "GitHub";

/** The reason recorded when the host closed a Context PR without merging it. */
export const closedOnHostReason = (
  repo: Pick<SteeringRepository, "provider">,
) => `Closed on ${hostName(repo)} without merging`;
