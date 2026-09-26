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

/** The Organization tabs that live on `/{org}` as a `?tab=` value. */
export type OrganizationQueryTab =
  | "people"
  | "invitations"
  | "workspaces"
  | "dataPlane"
  | "costCenters";

/**
 * The path segments each Steering tab or shelf id lands on, old ids included
 * (roadmap pages/steering.md, "Old URLs still land").
 */
const STEERING_SEGMENTS: Readonly<Record<string, readonly string[]>> = {
  library: ["library"],
  records: ["records"],
  instructions: ["instructions"],
  skills: ["skills"],
  memory: ["memory"],
  ontology: ["ontology"],
  assignments: ["assignments"],
  deliveries: ["assignments"],
  gates: ["gates"],
  policy: ["gates"],
  settings: ["gates"],
  freshness: ["gates"],
  proposals: ["proposals"],
  prs: ["proposals", "prs"],
  compiler: ["compiler"],
  preview: ["compiler"],
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
  /** `email` returns an address to the sign-up form, editable (Verify email's Change it). */
  signup: (next?: SafePath, q?: { email?: string }): SafePath =>
    withQuery(mint("/signup"), { next: nextParam(next), email: q?.email }),
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
  /**
   * The onboarding gate's later steps and the installer's screens, outside the
   * app shell (`(onboarding)/welcome/[org]/[ws]/[step]`). `agent` is the
   * identity the steps enrol, carried so a reload lands on the same one.
   */
  welcome: (
    org: string,
    ws: string,
    step: "wrap" | "run" | "installer",
    q?: { agent?: string },
  ): SafePath =>
    withQuery(pathOf("welcome", org, ws, step), { agent: q?.agent }),
  invite: (token: string): SafePath => pathOf("invite", token),
  cliAuthorize: (query: Readonly<Record<string, string>>): SafePath =>
    withQuery(mint("/cli/authorize"), query),
  /** Organization › People is the organization's root. */
  people: (org: string): SafePath => pathOf(org),
  /**
   * A tab of the Organization page that has no route of its own: People (the
   * root), Invitations, Workspaces, Data plane and Cost centers. The tab is a
   * query value on `/{org}`, left off for People.
   */
  organization: (org: string, tab: OrganizationQueryTab): SafePath =>
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
    q?: { workspace?: string; show?: string; rows?: string; offset?: string },
  ): SafePath =>
    withQuery(pathOf(org, "api-keys"), {
      workspace: q?.workspace,
      show: q?.show,
      rows: q?.rows,
      offset: q?.offset,
    }),
  /**
   * Organization › Model funding and routes: which key pays for Oxagen's own
   * model calls (ADR-053, ADR-131) and the route each tier takes. Org-scoped:
   * the key pays for every workspace.
   */
  modelFunding: (org: string): SafePath => pathOf(org, "model-funding"),
  /**
   * Organization › Single sign-on: the organisation's identity providers,
   * their domain proofs, and whether SSO is required (ADR-145).
   */
  sso: (org: string): SafePath => pathOf(org, "sso"),
  /**
   * Fleet; `cursor` opens a later page of its runs table, and `prs` lists
   * only the runs `with` or `without` pull requests (`any`, or absent, is all).
   * `q` is the search, `status`, `tier` and `replay` each carry a
   * comma-joined list, `sort` and `dir` the order, and `page` the page number
   * from 1 (#3837). A default is left out of the URL: `prs` `any`, the
   * `started` descending order, and page 1.
   */
  fleet: (
    org: string,
    ws: string,
    q?: {
      cursor?: string;
      prs?: "any" | "with" | "without";
      q?: string;
      status?: string;
      tier?: string;
      replay?: string;
      sort?: string;
      dir?: "asc" | "desc";
      page?: number;
    },
  ): SafePath => {
    const defaultOrder =
      (q?.sort ?? "started") === "started" && (q?.dir ?? "desc") === "desc";
    return withQuery(pathOf(org, ws), {
      prs: q?.prs === "any" ? undefined : q?.prs,
      q: q?.q === "" ? undefined : q?.q,
      status: q?.status === "" ? undefined : q?.status,
      tier: q?.tier === "" ? undefined : q?.tier,
      replay: q?.replay === "" ? undefined : q?.replay,
      sort: defaultOrder ? undefined : q?.sort,
      dir: defaultOrder ? undefined : q?.dir,
      page: q?.page === undefined || q.page <= 1 ? undefined : String(q.page),
      cursor: q?.cursor,
    });
  },
  /**
   * Agent IAM; `cursor` opens a later page of the identities table, and
   * `deregistered` lists retired agents beside the live ones.
   */
  agents: (
    org: string,
    ws: string,
    q?: { cursor?: string; view?: string; deregistered?: boolean },
  ): SafePath =>
    withQuery(pathOf(org, ws, "agents"), {
      deregistered: q?.deregistered === true ? "show" : undefined,
      cursor: q?.cursor,
      view: q?.view,
    }),
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
   * run steps, so a reload lands back on the same registration. `runtime`
   * opens the name step with that runtime chosen (`rtm_…`, ADR-198), which is
   * where Add a runtime lands.
   */
  register: (
    org: string,
    ws: string,
    step: string,
    q?: { agent?: string; runtime?: string },
  ): SafePath =>
    withQuery(pathOf(org, ws, "register", step), {
      agent: q?.agent,
      runtime: q?.runtime,
    }),
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
   * One of Audit's other tabs, each a URL segment under the page (§1.2). The
   * query carries the export Build bundle queued, on Exports.
   */
  auditTab: (
    org: string,
    tab: "incidents" | "receipts" | "exports" | "keys" | "retention",
    q: Readonly<Record<string, string | undefined>> = {},
  ): SafePath => withQuery(pathOf(org, "audit", tab), q),
  /**
   * The authenticated download of a queued data export. The archive is a
   * private object, so this route streams the bytes rather than the tab
   * linking at storage.
   */
  accountExport: (org: string, exportId: string): SafePath =>
    pathOf(org, "account", "export", exportId),
  /**
   * The route the flyout's Stop control posts to. It is a route rather than a
   * server action because the question it stops is itself a pending server
   * action, and the actions of one page run one at a time (#4164).
   */
  assistantStop: (org: string, ws: string): SafePath =>
    pathOf(org, ws, "assistant", "stop"),
  /** The signed export of Audit's events over the same query values. */
  auditExport: (
    org: string,
    q: Readonly<Record<string, string | undefined>>,
  ): SafePath => withQuery(pathOf(org, "audit", "export"), q),
  /**
   * A run opened from a list (a run id is a public id, never a raw row id).
   * `tab` picks the section, `kinds` the chips the transcript opens with
   * (comma-separated) and `frames` a later page of the frames. The spine above the tabs adds `reads`, which folds its read marks
   * away, and `spine`, the folded groups a person opened (comma-separated
   * indexes). Each is a query value, so the run keeps one route (§1.2).
   */
  run: (
    org: string,
    ws: string,
    run: string,
    q?: {
      tab?: string;
      kinds?: string;
      frames?: string;
      body?: string;
      reads?: string;
      spine?: string;
    },
  ): SafePath =>
    withQuery(pathOf(org, ws, "runs", run), {
      tab: q?.tab,
      kinds: q?.kinds,
      frames: q?.frames,
      body: q?.body,
      reads: q?.reads,
      spine: q?.spine,
    }),
  /**
   * Spend on one tab, with one key's drill or one finding's evidence open. The
   * tab and the drill are path segments (`/spend/agent/<key>`), as the mockup's
   * route names them, and the first tab is the bare path; a finding's evidence
   * is a dialog over the Findings tab, so it is a query value.
   */
  spend: (
    org: string,
    ws: string,
    view: { tab: string; drill?: string; finding?: string },
  ): SafePath =>
    withQuery(
      view.drill !== undefined
        ? pathOf(org, ws, "spend", view.tab, view.drill)
        : view.tab === "findings"
          ? pathOf(org, ws, "spend")
          : pathOf(org, ws, "spend", view.tab),
      { finding: view.finding },
    ),
  /**
   * Skills, the Skills shelf of the Steering library (roadmap pages/skills.md);
   * `cursor` opens a later page of the inventory. `/{org}/{ws}/skills`
   * redirects here.
   */
  skills: (org: string, ws: string, q?: { cursor: string }): SafePath =>
    withQuery(pathOf(org, ws, "steering", "skills"), {
      cursor: q?.cursor,
    }),
  /**
   * Tools; its tabs are path segments (`/tools/providers`), as the mockup's
   * route names them, and the first tab is the bare path. A category chip, a
   * provider chip, the API-names toggle, a cursor and the toolbelt open on the
   * Toolbelts tab (`belt`, ADR-198) are query values.
   */
  tools: (
    org: string,
    ws: string,
    q: {
      tab?: "toolbelts" | "providers" | "policy" | "switches";
      category?: string;
      provider?: string;
      names?: string;
      cursor?: string;
      belt?: string;
    } = {},
  ): SafePath =>
    withQuery(
      q.tab === undefined
        ? pathOf(org, ws, "tools")
        : pathOf(org, ws, "tools", q.tab),
      {
        category: q.category,
        provider: q.provider,
        names: q.names,
        cursor: q.cursor,
        belt: q.belt,
      },
    ),
  /**
   * Repositories; its tabs are path segments (`/repositories/changes`), as the
   * mockup's route names them, and the first tab is the bare path.
   */
  repositories: (
    org: string,
    ws: string,
    tab?: "working-copies" | "changes" | "configuration",
    /** One change on the Changes tab, by its proposal id: the Context PR page. */
    change?: string,
  ): SafePath =>
    tab === undefined
      ? pathOf(org, ws, "repositories")
      : tab === "changes" && change !== undefined
        ? pathOf(org, ws, "repositories", tab, change)
        : pathOf(org, ws, "repositories", tab),
  /** Runtimes: the hosts agents run on (roadmap mockups/pages/runtimes.md). */
  runtimes: (org: string, ws: string): SafePath => pathOf(org, ws, "runtimes"),
  /** One runtime, addressed by its enrollment's public id (`tch_…`). */
  runtime: (org: string, ws: string, runtime: string): SafePath =>
    pathOf(org, ws, "runtimes", runtime),
  /**
   * Steering (roadmap pages/steering.md): the five tabs and the Library
   * shelves are path segments, `/steering/<tab>` or `/steering/<shelf>`, and
   * the Context PRs segment of Proposals is `/steering/proposals/prs`. A tab
   * id written before the rename still maps to where it lives now: `policy`,
   * `settings` and `freshness` are Gates, `deliveries` is Assignments,
   * `preview` is the Compiler and `prs` is the Context PRs segment. Filters, a
   * page offset, a selected proposal and a Skills cursor stay query values.
   */
  steering: (
    org: string,
    ws: string,
    q: {
      tab?: string;
      /** The agent the Compiler assembles for; only with `tab: "compiler"`. */
      agent?: string;
      /** A skill whose source `/steering/skills/<skill>/source` opens; only with `tab: "skills"`. */
      skill?: string;
      kind?: string;
      offset?: string;
      proposal?: string;
      cursor?: string;
      view?: string;
    } = {},
  ): SafePath => {
    const segments =
      q.tab !== undefined && Object.hasOwn(STEERING_SEGMENTS, q.tab)
        ? [...(STEERING_SEGMENTS[q.tab] ?? [])]
        : [];
    if (segments[0] === "compiler" && q.agent !== undefined) {
      segments.push(q.agent);
    }
    if (segments[0] === "skills" && q.skill !== undefined) {
      segments.push(q.skill, "source");
    }
    return withQuery(pathOf(org, ws, "steering", ...segments), {
      kind: q.kind,
      offset: q.offset,
      proposal: q.proposal,
      cursor: q.cursor,
      view: q.view,
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
