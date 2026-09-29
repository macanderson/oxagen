// Where Slack sends the browser back after Connect Slack (#4608):
// `/api/slack/oauth/callback`. It reads and deletes the cookie Connect Slack
// set, checks that Slack echoed the same `state`, finishes the connection
// with the `code`, and returns the browser to Organization › Notifications
// with the outcome in one word.
//
// The `code` and the `state` never leave this function: no redirect, log,
// error, or response body carries either one. A request with no readable
// cookie names no organization to return to, so it gets a plain 400.
import { cookies } from "next/headers";
import { z } from "zod";
import type { ActionResult } from "@/server/kernel";
import { responseRedirect } from "@/shared/navigation";
import { routes, type SlackConnectOutcome } from "@/shared/safe-path";
import { completeSlackConnection } from "./slack-actions";
import { SLACK_CONNECT_COOKIE } from "./slack-connect-cookie";

const cookieSchema = z.object({
  org: z.string().min(1),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** The longest `code` the authorize contract accepts. */
const MAX_CODE_LENGTH = 512;

const UNVERIFIED =
  "Oxagen could not verify this Slack connection. Return to Organization › Notifications and select Connect Slack again.";

/** The Slack refusals that mean the link expired or belongs to someone else. */
const EXPIRED_CODES: ReadonlySet<string> = new Set([
  "slack_oauth_state_expired",
  "slack_oauth_state_invalid",
  "slack_oauth_state_mismatch",
]);

/** The refusals that mean Slack did not grant what Oxagen needs. */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  "slack_oauth_exchange_failed",
  "slack_app_mismatch",
  "slack_scope_missing",
]);

/** How a refused `authorize_slack_connection` reads on the page, in one word. */
function outcomeOf(
  failure: Exclude<ActionResult<null>, { ok: true }>,
): SlackConnectOutcome {
  if (failure.reason === "pending_approval") return "pendingApproval";
  if (failure.reason === "exhausted") return "unavailable";
  if (EXPIRED_CODES.has(failure.code)) return "expired";
  if (REFUSED_CODES.has(failure.code)) return "refused";
  if (failure.code === "slack_not_configured") return "notConfigured";
  if (failure.reason === "denied") return "denied";
  return "unavailable";
}

export async function handleSlackCallback(request: Request): Promise<Response> {
  const jar = await cookies();
  const raw = jar.get(SLACK_CONNECT_COOKIE.name)?.value;
  jar.set(SLACK_CONNECT_COOKIE.name, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: SLACK_CONNECT_COOKIE.path,
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw ?? "null");
  } catch {
    return new Response(UNVERIFIED, { status: 400 });
  }
  const cookie = cookieSchema.safeParse(decoded);
  if (!cookie.success) return new Response(UNVERIFIED, { status: 400 });
  const { org, state } = cookie.data;
  const back = (slack: SlackConnectOutcome) =>
    responseRedirect(request, routes.notifications(org, { slack }));

  const query = new URL(request.url).searchParams;
  // Slack answers `error=access_denied` when the person selects Cancel.
  if (query.has("error")) return back("cancelled");
  const code = query.get("code") ?? "";
  if (
    query.get("state") !== state ||
    code === "" ||
    code.length > MAX_CODE_LENGTH
  )
    return back("expired");

  const result = await completeSlackConnection(org, { state, code });
  return back(result.ok ? "connected" : outcomeOf(result));
}
