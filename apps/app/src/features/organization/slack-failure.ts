// The sentences Organization › Notifications shows for Slack (#4608): a
// refused Slack write, the last post Slack refused, and how a connection
// attempt ended. The kernel classifies a refused write and puts the handler's
// HandlerError reason in `code` (§3.2), so each Slack code the handlers throw
// gets its own sentence here. Any other code is printed as recorded. The
// reading is the kit's (`@/ui/action-failure`); only the vocabulary is this
// tab's.
//
// Every key below is relative to `organization.notifications` and takes no
// argument, so a translator bound to that namespace reads each one with a
// literal-typed key and `catalog-used` (INV-12) sees it read.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import type { SlackConnectOutcome } from "@/shared/safe-path";
import { readFailure, unanswered } from "@/ui/action-failure";

type SlackActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

const WORDS = {
  refused: {
    // The person is below Owner or Admin: the handler's own role check, IAM,
    // or, for the channel list, the permission the read needed.
    denied: "readOnly",
    org_role_required: "readOnly",
    human_authorization_required: "readOnly",
    authz_denied: "readOnly",
    "org.admin": "readOnly",
    slack_not_configured: "unavailable",
    slack_not_connected: "failure.notConnected",
    slack_connection_broken: "failure.broken",
    slack_channel_not_found: "failure.channelGone",
    slack_channel_archived: "failure.channelGone",
    slack_connection_changed: "failure.connectionChanged",
  },
  unavailable: {
    slack_not_configured: "unavailable",
  },
} as const;

/** The sentence a refused Slack write shows. */
export function useSlackFailure(): (failure: SlackActionFailure) => string {
  const t = useTranslations("organization.notifications");
  return (failure) => {
    const reading = readFailure(WORDS, failure);
    switch (reading.kind) {
      case "named":
        return t(reading.key);
      case "refused":
        return t("failure.refused", { code: reading.code });
      case "invalid":
        return t("failure.invalid");
      case "pendingApproval":
        return t("failure.pendingApproval", {
          accessRequestId: reading.accessRequestId,
        });
      case "unavailable":
        return t("failure.unavailable", { code: reading.code });
    }
  };
}

/** A Slack write that threw before it answered, as the seam would name it. */
export const UNANSWERED: SlackActionFailure = unanswered("action_failed");

/**
 * The Slack error codes a failed post can record, each with the sentence that
 * says what to do. `token_unreadable` is Oxagen's own: the stored token could
 * not be decrypted.
 */
const LAST_FAILURE_WORDS = {
  not_in_channel: "lastFailure.notInChannel",
  channel_not_found: "lastFailure.channelNotFound",
  is_archived: "lastFailure.isArchived",
  token_revoked: "lastFailure.tokenRevoked",
  invalid_auth: "lastFailure.tokenRevoked",
  account_inactive: "lastFailure.tokenRevoked",
  missing_scope: "lastFailure.missingScope",
  token_unreadable: "lastFailure.tokenUnreadable",
} as const;

type LastFailureKey =
  (typeof LAST_FAILURE_WORDS)[keyof typeof LAST_FAILURE_WORDS];

const LAST_FAILURE_KEYS: Readonly<Record<string, LastFailureKey>> =
  LAST_FAILURE_WORDS;

/**
 * The sentence key for a failed post's code, or null for a code with no
 * sentence of its own, which the page prints as recorded. Own properties
 * only: a code spelt like a prototype member is not a match.
 */
export function lastFailureKey(code: string): LastFailureKey | null {
  return Object.hasOwn(LAST_FAILURE_KEYS, code)
    ? (LAST_FAILURE_KEYS[code] ?? null)
    : null;
}

/** How a connection attempt ended, as the line under the panel's facts says it. */
export const OUTCOME_KEYS = {
  connected: "outcome.connected",
  cancelled: "outcome.cancelled",
  expired: "outcome.expired",
  refused: "outcome.refused",
  pendingApproval: "outcome.pendingApproval",
  unavailable: "outcome.unavailable",
  // The callback's write was refused on role: the person who came back from
  // Slack is below Owner or Admin.
  denied: "readOnly",
  notConfigured: "unavailable",
} as const satisfies Record<SlackConnectOutcome, string>;
