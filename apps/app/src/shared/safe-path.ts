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

const AGENT_SECTION_ALIASES: Readonly<Record<string, string>> = {
  enrollment: "runtime",
  budgets: "permissions",
  mandates: "permissions",
  incidents: "activity",
  runs: "activity",
};

/** Every route the app navigates to; each builder returns a SafePath. */
export const routes = {
  root: (): SafePath => ROOT,
  login: (next?: SafePath): SafePath =>
    withQuery(mint("/login"), { next: nextParam(next) }),
  /**
   * /login carrying a Better Auth OAuth `error` query value. Used when the
   * proxy lifts `/?error=` onto the login page, and as `errorCallbackURL` for
   * social sign-in so a failed Google/GitHub attempt is visible instead of a
   * blank form.
   */
  loginWithOAuthError: (error: string, next?: SafePath): SafePath =>
    withQuery(mint("/login"), {
      next: nextParam(next),
      error: error.trim() === "" ? undefined : error,
    }),
  /** Where requireViewer sends a member whose organization requires SSO and whose session is not one (sso-gate.ts); outside `[org]`, so it cannot loop. */
  ssoRequired: (next?: SafePath): SafePath =>
    withQuery(mint("/login"), { next: nextParam(next), sso: "required" }),
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
  organization: (
    org: string,
    tab: "people" | "invitations" | "workspaces" | "costCenters",
  ): SafePath =>
    withQuery(pathOf(org), { tab: tab === "people" ? undefined : tab }),
  /** Organization › Roles: the roles and the permission catalogue (#2964). */
  roles: (org: string): SafePath => pathOf(org, "roles"),
  /**
   * Organization › API keys. A key names a workspace (ADR-073), so the
   * workspace in scope is a query value on this one route rather than a route
   * of its own; left off, the page takes the viewer's first workspace.
   * `show` widens the roster to the revoked keys it hides by default and
   * `offset` opens a later page of it — a filter and a page are query values,
   * not routes (ARCHITECTURE.md §1.2).
   */
  apiKeys: (
    org: string,
    q?: { workspace?: string; show?: string; offset?: string },
  ): SafePath =>
    withQuery(pathOf(org, "api-keys"), {
      workspace: q?.workspace,
      show: q?.show,
      offset: q?.offset,
    }),
  /**
   * Organization › Model funding: whose key pays for the assistant's model
   * calls (ADR-053 §2). Org-scoped — the key pays for every workspace.
   */
  modelFunding: (org: string): SafePath => pathOf(org, "model-funding"),
  /**
   * Organization › Single sign-on: the organisation's identity providers,
   * their domain proofs, and whether SSO is required (ADR-145).
   */
  sso: (org: string): SafePath => pathOf(org, "sso"),
  /** Fleet; `cursor` opens a later page of its runs table. */
  fleet: (org: string, ws: string, q?: { cursor: string }): SafePath =>
    withQuery(pathOf(org, ws), { cursor: q?.cursor }),
  /** Agent IAM; `cursor` opens a later page of the identities table. */
  agents: (
    org: string,
    ws: string,
    q?: { cursor?: string; view?: string },
  ): SafePath =>
    withQuery(pathOf(org, ws, "agents"), { cursor: q?.cursor, view: q?.view }),
  /** One agent; `tab` picks the section, `cursor` a later page of its incidents. */
  agent: (
    org: string,
    ws: string,
    agent: string,
    q?: { tab: string; cursor?: string },
  ): SafePath =>
    withQuery(
      q?.tab === undefined
        ? pathOf(org, ws, "agents", agent)
        : pathOf(
            org,
            ws,
            "agents",
            agent,
            Object.hasOwn(AGENT_SECTION_ALIASES, q.tab)
              ? (AGENT_SECTION_ALIASES[q.tab] ?? q.tab)
              : q.tab,
          ),
      {
        cursor: q?.cursor,
      },
    ),
  /** The agent's definition file in the source editor. */
  agentSource: (org: string, ws: string, agent: string): SafePath =>
    pathOf(org, ws, "agents", agent, "source"),
  /**
   * One mandate (#2957), at the flat route ARCHITECTURE.md §1.2 states:
   * `/{org}/{ws}/mandates/{mandate}`.
   *
   * Flat rather than under the agent, although the mockup's route nests it. A
   * mandate's public id identifies it inside the workspace on its own, and
   * `get_mandate` takes that id alone — so an agent segment above it would be a
   * second name for the same record that nothing checks, and a link carrying the
   * wrong agent would have opened the right mandate anyway. The agent is reached
   * from the record instead: the page's header links to the agent the mandate was
   * granted to.
   *
   * `q` searches the ledger, `state` narrows it to one movement kind and
   * `offset` opens a later page of it. All three are query values, not routes,
   * for the reason every other filter and page here is.
   */
  mandate: (
    org: string,
    ws: string,
    mandate: string,
    q?: { search?: string; state?: string; offset?: string },
  ): SafePath =>
    withQuery(pathOf(org, ws, "mandates", mandate), {
      q: q?.search,
      state: q?.state,
      offset: q?.offset,
    }),
  /**
   * One step of Register an agent (#2967, ADR-065 decision 1). `agent` carries
   * the identity `register_agent` minted from the name step to the wrap and
   * run steps, so a reload lands back on the same registration.
   */
  register: (
    org: string,
    ws: string,
    step: string,
    q?: { agent: string },
  ): SafePath =>
    withQuery(pathOf(org, ws, "register", step), { agent: q?.agent }),
  /**
   * Billing; `cursor` opens a later page of its invoices, `checkout` is where
   * a Stripe Checkout returns. The two meters return to different values —
   * `success` for a governed-action-unit purchase, `credits` for a usage
   * credit top-up — so the page can name the meter the payment landed on;
   * `plan` for a plan change; `cancel` is shared, because nothing was charged.
   */
  billing: (
    org: string,
    q?:
      | { cursor: string }
      | { checkout: "success" | "cancel" | "credits" | "plan" },
  ): SafePath =>
    withQuery(pathOf(org, "billing"), {
      cursor: q !== undefined && "cursor" in q ? q.cursor : undefined,
      checkout: q !== undefined && "checkout" in q ? q.checkout : undefined,
    }),
  /** Audit's events; a filter or a page is a query value, not a route (§1.2). */
  audit: (
    org: string,
    q: Readonly<Record<string, string | undefined>> = {},
  ): SafePath => withQuery(pathOf(org, "audit"), q),
  /**
   * The authenticated download of a queued data export. The archive is a
   * private object, so this route streams the bytes rather than the tab
   * linking at storage.
   */
  accountExport: (org: string, exportId: string): SafePath =>
    pathOf(org, "account", "export", exportId),
  /** The signed export of Audit's events over the same query values. */
  auditExport: (
    org: string,
    q: Readonly<Record<string, string | undefined>>,
  ): SafePath => withQuery(pathOf(org, "audit", "export"), q),
  /**
   * A run opened from a list (a run id is a public id, never a raw row id).
   * `tab` picks the section, `zoom` the transcript's level, `kinds` the chips
   * it is filtered by (comma-separated) and `frames` a later page of the
   * frames. The spine above the tabs adds `reads`, which folds its read marks
   * away, and `spine`, the folded groups a person opened (comma-separated
   * indexes). Each is a query value, so the run keeps one route (§1.2).
   */
  run: (
    org: string,
    ws: string,
    run: string,
    q?: {
      tab?: string;
      zoom?: string;
      kinds?: string;
      frames?: string;
      body?: string;
      reads?: string;
      spine?: string;
    },
  ): SafePath =>
    withQuery(pathOf(org, ws, "runs", run), {
      tab: q?.tab,
      zoom: q?.zoom,
      kinds: q?.kinds,
      frames: q?.frames,
      body: q?.body,
      reads: q?.reads,
      spine: q?.spine,
    }),
  /** Spend on one tab, with one key's drill or one finding's evidence open; a tab is a query, not a route (§1.2). */
  spend: (
    org: string,
    ws: string,
    view: { tab: string; drill?: string; finding?: string },
  ): SafePath =>
    withQuery(pathOf(org, ws, "spend"), {
      tab: view.tab,
      drill: view.drill,
      finding: view.finding,
    }),
  /**
   * Skills, the Skills tab of Steering (MC spec §10.7); `cursor` opens a later
   * page of the inventory. `/{org}/{ws}/skills` redirects here.
   */
  skills: (org: string, ws: string, q?: { cursor: string }): SafePath =>
    withQuery(pathOf(org, ws, "steering"), {
      tab: "skills",
      cursor: q?.cursor,
    }),
  /**
   * Tools; a tab, a category chip, the API-names toggle and a cursor are query
   * values on the one route (#2958 adds no route, ARCHITECTURE.md §1.2).
   */
  tools: (
    org: string,
    ws: string,
    q: {
      tab?: string;
      category?: string;
      names?: string;
      cursor?: string;
    } = {},
  ): SafePath =>
    withQuery(pathOf(org, ws, "tools"), {
      tab: q.tab,
      category: q.category,
      names: q.names,
      cursor: q.cursor,
    }),
  /**
   * Repositories; its tabs are path segments (`/repositories/changes`), as the
   * mockup's route names them, and the first tab is the bare path.
   */
  repositories: (
    org: string,
    ws: string,
    tab?: "working-copies" | "changes" | "configuration",
  ): SafePath =>
    tab === undefined
      ? pathOf(org, ws, "repositories")
      : pathOf(org, ws, "repositories", tab),
  /** Canonical Steering sections, with legacy query links retained for redirects. */
  steering: (
    org: string,
    ws: string,
    q: {
      tab?: string;
      shelf?: string;
      section?: string;
      kind?: string;
      offset?: string;
      proposal?: string;
      cursor?: string;
      view?: string;
    } = {},
  ): SafePath => {
    const canonical =
      q.tab !== undefined &&
      ["library", "proposals", "freshness", "deliveries"].includes(q.tab)
        ? q.tab
        : null;
    const segments = canonical === null ? [] : [canonical];
    if (q.tab === "library" && q.shelf && q.shelf !== "all")
      segments.push(q.shelf);
    return withQuery(pathOf(org, ws, "steering", ...segments), {
      tab: canonical === null ? q.tab : undefined,
      kind: q.kind,
      offset: q.offset,
      proposal: q.proposal,
      cursor: q.cursor,
      view: q.view,
      section: q.section,
    });
  },
  /**
   * One published record, by its lineage (#3395). The lineage is a file stem
   * under `.oxagen/rules/`, so it reaches here from the repository rather
   * than from us; `pathOf` percent-encodes it, which is what keeps a lineage
   * carrying a slash or a dot segment inside this one route.
   */
  steeringRecord: (org: string, ws: string, lineage: string): SafePath =>
    pathOf(org, ws, "steering", "records", lineage),
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
