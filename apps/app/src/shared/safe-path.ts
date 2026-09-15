// Same-origin navigation targets (ARCHITECTURE.md §3.8, INV-13). A SafePath is
// a path on this app: it starts with "/", and neither "//" (protocol-relative,
// another host) nor "/\" (browsers normalise the backslash to a slash, which
// makes it "//" again), and it carries no control character or backslash
// (browsers strip tab and newline inside URLs, so "/\t/evil" would also become
// "//evil"). Only `sanitizeNext` and the route builders below mint one.
//
// `?next=` arrives from the address bar, so it is attacker-controlled.
// `sanitizeNext` resolves it against a sentinel origin and checks the
// *normalised* result again ("/a/../..//evil" resolves to "//evil"), and
// refuses a destination back into the sign-in flow, so a crafted link cannot
// loop a person between log in and two-factor.

declare const safePath: unique symbol;
export type SafePath = string & { readonly [safePath]: true };

/** Longest `next` accepted; the CLI authorize round-trip carries a PKCE challenge and a loopback URI. */
const MAX_NEXT_LENGTH = 2048;

const SENTINEL_ORIGIN = "http://mission-control.invalid";

const SIGN_IN_FLOW =
  /^\/(login|signup|verify|two-factor|forgot-password|reset-password)(\/|$)/;

/** A C0 control character, DEL, or a backslash anywhere in the value. */
function hasUnsafeCharacter(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

function isSamePath(raw: string): raw is SafePath {
  return (
    raw.startsWith("/") && !raw.startsWith("//") && !hasUnsafeCharacter(raw)
  );
}

/** The one mint for built paths: a builder whose output is not a same-origin path is a programming error. */
function mint(path: string): SafePath {
  if (isSamePath(path)) return path;
  throw new Error(`unsafe_path ${JSON.stringify(path)}`);
}

/** `/seg/seg…` with every segment percent-encoded; an empty first segment would make a host and is refused. */
export function pathOf(...segments: readonly string[]): SafePath {
  return mint(`/${segments.map(encodeURIComponent).join("/")}`);
}

const ROOT = mint("/");

function withQuery(
  path: SafePath,
  query: Readonly<Record<string, string | undefined>>,
): SafePath {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const search = params.toString();
  return search === "" ? path : mint(`${path}?${search}`);
}

/** A `next` query value, left off when the destination is the root. */
const nextParam = (next: SafePath | undefined): string | undefined =>
  next === undefined || next === ROOT ? undefined : next;

/** Every route the app navigates to; each builder returns a SafePath. */
export const routes = {
  root: (): SafePath => ROOT,
  login: (next?: SafePath): SafePath =>
    withQuery(mint("/login"), { next: nextParam(next) }),
  signup: (next?: SafePath): SafePath =>
    withQuery(mint("/signup"), { next: nextParam(next) }),
  verify: (q: { email: string; next?: SafePath }): SafePath =>
    withQuery(mint("/verify"), { email: q.email, next: nextParam(q.next) }),
  twoFactor: (next?: SafePath): SafePath =>
    withQuery(mint("/two-factor"), { next: nextParam(next) }),
  /** Where requireViewer sends a privileged member whose MFA enrollment is overdue; outside `[org]`, so it cannot loop. */
  mfaEnroll: (): SafePath =>
    withQuery(mint("/two-factor"), { enroll: "required" }),
  resetPassword: (): SafePath => mint("/reset-password"),
  newOrganization: (next?: SafePath): SafePath =>
    withQuery(mint("/new-organization"), { next: nextParam(next) }),
  invite: (token: string): SafePath => pathOf("invite", token),
  cliAuthorize: (query: Readonly<Record<string, string>>): SafePath =>
    withQuery(mint("/cli/authorize"), query),
  /** Organization › People is the organization's root. */
  people: (org: string): SafePath => pathOf(org),
  apiKeys: (org: string): SafePath => pathOf(org, "api-keys"),
  fleet: (org: string, ws: string): SafePath => pathOf(org, ws),
  /** Billing; `cursor` opens a later page of its invoices, `checkout` is where a Stripe Checkout returns. */
  billing: (
    org: string,
    q?: { cursor: string } | { checkout: "success" | "cancel" },
  ): SafePath =>
    withQuery(pathOf(org, "billing"), {
      cursor: q !== undefined && "cursor" in q ? q.cursor : undefined,
      checkout: q !== undefined && "checkout" in q ? q.checkout : undefined,
    }),
  /** A run opened from a list (a run id is a public id, never a raw row id). */
  run: (org: string, ws: string, run: string): SafePath =>
    pathOf(org, ws, "runs", run),
  /** Spend on one tab, or one key's drill on it; a tab is a query, not a route (§1.2). */
  spend: (
    org: string,
    ws: string,
    view: { tab: string; drill?: string },
  ): SafePath =>
    withQuery(pathOf(org, ws, "spend"), { tab: view.tab, drill: view.drill }),
  /** Skills; `cursor` opens a later page of the inventory. */
  skills: (org: string, ws: string, q?: { cursor: string }): SafePath =>
    withQuery(pathOf(org, ws, "skills"), { cursor: q?.cursor }),
};

/**
 * `raw` as a same-origin path (with its query and hash) when it is safe to
 * navigate to after sign-in, or `fallback` otherwise. Never throws.
 */
export function sanitizeNext(raw: string | null, fallback: SafePath): SafePath {
  if (raw === null || raw.length > MAX_NEXT_LENGTH || !isSamePath(raw))
    return fallback;
  // A same-origin path resolves against the sentinel without leaving it; what
  // can change is the path itself, so the normalised result is checked again.
  const url = new URL(raw, SENTINEL_ORIGIN);
  if (SIGN_IN_FLOW.test(url.pathname)) return fallback;

  const path = `${url.pathname}${url.search}${url.hash}`;
  return isSamePath(path) ? path : fallback;
}

/** The first value of a Next.js search param, which may arrive repeated. */
export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The sanitised destination a page was asked for: `?next=`, or `?returnTo=`
 * when `next` is absent, under the rules of `sanitizeNext`. `returnTo` is the
 * name the CLI's `oxagen auth login --signup` (apps/cli/src/auth/loopback-login.ts)
 * and the deprecated app put on /signup and /login, so a new account made from
 * the CLI or the desktop installer still comes back to the consent page. A
 * present `next` that is refused yields `fallback` and never falls through to
 * `returnTo`. Pages read the destination through this function only.
 */
export function readNext(
  params: Readonly<Record<string, string | string[] | undefined>>,
  fallback: SafePath = ROOT,
): SafePath {
  return sanitizeNext(
    firstParam(params.next) ?? firstParam(params.returnTo) ?? null,
    fallback,
  );
}
