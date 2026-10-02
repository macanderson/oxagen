// The steering connect's landing (/github/steering): a callback, not a page
// (#5151). The API's GitHub callback sends every steering connect here, with
// the `return_to` the connect started from and the outcome: `steering`, and
// `code` on a failure.
//
// The return is usually an organization page, `/{org}/…` or
// `/welcome/{org}/…`, and those answer 404 to anyone who isn't a member. The
// browser that finishes a GitHub install can be signed in to another Oxagen
// account than the one that started the connect, so going straight there
// ended a working install on "Page not found". This landing checks first:
//
//   a member, or a return that names no organization → return_to, outcome kept
//   not a member, or no such organization            → the result page
//   no session                                        → log in, then back here
//
// The result page reads the same for an unknown organization and one the
// viewer can't open, so the landing confirms nothing about the slug.
import { RESERVED_ORG_SLUGS } from "@oxagen/oxagen/contracts/org.create";
import type { RouteViewer } from "@/server/viewer";
import { responseRedirect } from "@/shared/navigation";
import {
  routes,
  type SafePath,
  type SteeringOutcome,
  sanitizeNext,
  withSteeringOutcome,
} from "@/shared/safe-path";
import { parseSteeringResult } from "./ui/steering-result";

export type SteeringLandingDeps = {
  resolveViewer: (org: string) => Promise<RouteViewer>;
};

/** Onboarding's routes carry the organization second: `/welcome/{org}/…`. */
const ONBOARDING_SEGMENT = "welcome";

/**
 * The organization slug `returnTo` opens, or null for a path that names none,
 * such as `/` or `/new-organization`. A reserved first segment is an app
 * page, never an organization (`create_org` refuses those slugs).
 */
function steeringReturnOrg(returnTo: SafePath): string | null {
  const [first = "", second = ""] = new URL(returnTo, "http://landing.invalid")
    .pathname.split("/")
    .slice(1);
  if (first === ONBOARDING_SEGMENT) return second === "" ? null : second;
  if (first === "" || RESERVED_ORG_SLUGS.has(first)) return null;
  return first;
}

export async function handleSteeringLanding(
  request: Request,
  deps: SteeringLandingDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = sanitizeNext(
    url.searchParams.get("return_to"),
    routes.root(),
  );
  const result = parseSteeringResult(
    url.searchParams.get("steering"),
    url.searchParams.get("code"),
  );
  const outcome: SteeringOutcome | null =
    result === null
      ? null
      : result.kind === "connected"
        ? { steering: "connected" }
        : { steering: "error", code: result.code };
  const onward =
    outcome === null ? returnTo : withSteeringOutcome(returnTo, outcome);

  const org = steeringReturnOrg(returnTo);
  if (org === null) return responseRedirect(request, onward);

  const viewer = await deps.resolveViewer(org);
  switch (viewer.kind) {
    case "unauthenticated":
      return responseRedirect(
        request,
        routes.login(
          sanitizeNext(`${url.pathname}${url.search}`, routes.root()),
        ),
      );
    case "not_found":
      // With no outcome there is nothing to report, so the person goes home.
      return responseRedirect(
        request,
        outcome === null ? routes.root() : routes.steeringConnectResult(outcome),
      );
    case "ok":
    case "redirect":
    case "mfa_enroll":
    case "sso_required":
      // The organization's own gate moves a renamed slug, asks for two-factor
      // enrollment or single sign-on, exactly as it does without the landing.
      return responseRedirect(request, onward);
  }
}
