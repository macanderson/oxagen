// The sentence an OAuth sign-in failure shows, in the wizard and on a
// provider's Reconnect (#4132). Both drive `useProviderOAuth`, so both read
// the same failure and must say the same thing about it.
//
// A failure reaches the popup flow from three places:
//   - `start_provider_authorization`, refused by the kernel. It carries the
//     seam's real `reason` and `code`.
//   - the callback page, which posts only a code (`access_denied`,
//     `authorization_expired`, `authorization_failed`, or a kernel code
//     `complete_provider_authorization` threw). It carries no reason, so the
//     flow records it as `unavailable`.
//   - the flow itself: a sign-in address that is not https
//     (`authorization_url_invalid`) or a start that threw (`action_failed`).
//
// Each OAuth code has its own sentence under `tools.import.oauth.failure`,
// whatever reason it arrived under. Any other failure goes to the Tools
// writes' shared reading with its real reason, so a code that reading names
// (`no_principal`, `pending_approval`, an invalid input) is not printed raw
// under the wrong reason.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import { useActionFailure } from "./action-failure";

export type OAuthFailure = Exclude<ActionResult<unknown>, { ok: true }>;

/** The codes that have their own sentence under `tools.import.oauth.failure`. */
const OAUTH_FAILURE_CODES = [
  "access_denied",
  "authorization_expired",
  "authorization_failed",
  "authorization_discovery_failed",
  "registration_refused",
  "authorization_url_invalid",
  "endpoint_not_public",
  "redirect_url_invalid",
  "server_not_found",
  "org_role_required",
] as const;

type OAuthFailureCode = (typeof OAUTH_FAILURE_CODES)[number];

function isOAuthFailureCode(code: string): code is OAuthFailureCode {
  return OAUTH_FAILURE_CODES.some((known) => known === code);
}

/** A failure known only by its code, as the callback page or the flow names it. */
export function oauthCodeFailure(code: string): OAuthFailure {
  return { ok: false, reason: "unavailable", code };
}

export function useOAuthFailureText(): (failure: OAuthFailure) => string {
  const t = useTranslations("tools.import.oauth.failure");
  const failureText = useActionFailure();
  return (failure) => {
    if ("code" in failure && isOAuthFailureCode(failure.code)) {
      return t(failure.code);
    }
    return failureText(failure);
  };
}
