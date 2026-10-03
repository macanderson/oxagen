// The rev1 route table the page-load oracle walks (ARCHITECTURE.md §6.3).
//
// One row per page a person opens: the path a person navigates to, and the
// `pages.*` key whose copy the page's generateMetadata returns. The root layout
// composes the document title as `%s · Oxagen` (src/app/layout.tsx), so a row
// asserts `<pages[titleKey]> · Oxagen` and nothing else — a page that renders an
// error boundary or a not-found keeps its own title, so the assertion fails
// rather than passing on a broken page. A work item's page is the one row whose
// title names more than its page: `WI-1 · Work item · Oxagen` (expectedTitle).
// A page titled from another namespace (sign-up, a register step, the first
// workspace steps) carries that catalog string as `title` instead of a key.
//
// Every `page.tsx` under src/app is reached by a row here, or is a named
// exception in src/test/arch/e2e-routes.test.ts (INV-20), which resolves each
// row's path to the page Next would serve for it.
//
// The table is data so the same rows can be read by the deploy verification
// (WL-52) against a real organization, not only by the e2e run against the seed.
import auth from "../messages/auth.json" with { type: "json" };
import pages from "../messages/en.json" with { type: "json" };
import onboarding from "../messages/onboarding.json" with { type: "json" };
import { SEED, type SeedRecord } from "./support";

type PagesKey = keyof (typeof pages)["pages"];

export type RouteRow = {
  /** The path to visit, with the seeded org and workspace already substituted. */
  readonly path: string;
} & (
  | {
      /** The `pages.*` key the page's generateMetadata returns. */
      readonly titleKey: PagesKey;
    }
  | {
      /** The catalog string a page titled outside `pages.*` returns. */
      readonly title: string;
    }
);

/** A path whose page only moves the browser on, and the row it lands on. */
export type RedirectRow = {
  readonly path: string;
  /** A row of SIGNED_IN_ROUTES: the walk holds the landing to its path and title. */
  readonly landsOn: RouteRow;
};

const org = SEED.orgSlug;
const ws = SEED.workspaceSlug;

/**
 * A request the CLI's loopback login sends (RFC 8252, RFC 7636). The
 * challenge is RFC 7636's own example, so the consent form renders rather
 * than the invalid-request panel.
 */
const CLI_AUTHORIZE_QUERY = new URLSearchParams({
  redirect_uri: "http://127.0.0.1:53682/callback",
  state: "e2e-state",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
}).toString();

/** Every signed-in rev1 surface, in navigation order. */
export const SIGNED_IN_ROUTES: readonly RouteRow[] = [
  { path: `/${org}/${ws}/work`, titleKey: "work" },
  { path: `/${org}/${ws}/work?tab=running`, titleKey: "work" },
  { path: `/${org}/${ws}/work?tab=review`, titleKey: "work" },
  { path: `/${org}/${ws}/work?tab=done`, titleKey: "work" },
  // The one work item seed:e2e enters. Its title names the item first.
  { path: `/${org}/${ws}/work/${SEED.workItemNumber}`, titleKey: "workItem" },
  { path: `/${org}/${ws}/work/setup`, titleKey: "workSetup" },
  { path: `/${org}/${ws}/work/setup?tab=priorities`, titleKey: "workSetup" },
  { path: `/${org}/${ws}/work/setup?tab=runtimes`, titleKey: "workSetup" },
  { path: `/${org}/${ws}/work/outcomes`, titleKey: "workOutcomes" },
  { path: `/${org}/${ws}`, titleKey: "fleet" },
  { path: `/${org}/${ws}/agents`, titleKey: "agents" },
  // The agent seed:e2e registers: its bare page is Overview, as is the tab.
  { path: `/${org}/${ws}/agents/e2e-agent`, titleKey: "agent" },
  { path: `/${org}/${ws}/agents/e2e-agent/overview`, titleKey: "agent" },
  { path: `/${org}/${ws}/agents?tab=mcp-servers`, titleKey: "agents" },
  { path: `/${org}/${ws}/agents?tab=policies`, titleKey: "agents" },
  { path: `/${org}/${ws}/agents?tab=runtimes`, titleKey: "agents" },
  { path: `/${org}/${ws}/agents?tab=switches`, titleKey: "agents" },
  // Register an agent, first step. The tab names the step, as its h1 does.
  {
    path: `/${org}/${ws}/register/name`,
    title: onboarding.onboarding.register.name.title,
  },
  { path: `/${org}/${ws}/steering`, titleKey: "steering" },
  { path: `/${org}/${ws}/steering/library`, titleKey: "steering" },
  // The Skills shelf of the Library. `/skills` and every path under it
  // redirect here, so this row is the one page load of the skills inventory
  // (#3098).
  { path: `/${org}/${ws}/steering/skills`, titleKey: "steering" },
  { path: `/${org}/${ws}/repositories`, titleKey: "repositories" },
  { path: `/${org}/${ws}/spend`, titleKey: "spend" },
  { path: `/${org}/${ws}/spend/tokens`, titleKey: "spend" },
  { path: `/${org}`, titleKey: "people" },
  { path: `/${org}/roles`, titleKey: "roles" },
  { path: `/${org}/api-keys`, titleKey: "apiKeys" },
  { path: `/${org}/model-funding`, titleKey: "modelFunding" },
  { path: `/${org}/sso`, titleKey: "sso" },
  { path: `/${org}/billing`, titleKey: "billing" },
  { path: `/${org}/audit`, titleKey: "audit" },
  { path: `/${org}/audit/incidents`, titleKey: "audit" },
  { path: "/new-organization", titleKey: "newOrganization" },
  // Onboarding's connect and first-workspace steps. The seeded organization
  // already has its workspace, so the second shows its provisioning.
  {
    path: `/welcome/${org}/new-workspace/connect`,
    title: onboarding.onboarding.welcome.connect.pageTitle,
  },
  {
    path: `/welcome/${org}/new-workspace`,
    title: onboarding.onboarding.welcome.workspace.pageTitle,
  },
  { path: `/welcome/${org}/${ws}/wrap`, titleKey: "welcomeWrap" },
  { path: `/welcome/${org}/${ws}/run`, titleKey: "welcomeRun" },
  { path: `/welcome/${org}/${ws}/installer`, titleKey: "installer" },
  // The CLI consent page, for an owner the CLI sent with a well-formed request.
  { path: `/cli/authorize?${CLI_AUTHORIZE_QUERY}`, titleKey: "cliAuthorize" },
  // The second factor's page. The proxy admits a session as a first factor
  // (src/proxy.ts), so the owner sees the code form.
  { path: "/two-factor", titleKey: "twoFactor" },
  // Where a GitHub install ends for a browser that can't open the organization
  // that started the connect (#5151). The landing sends nobody here who can.
  {
    path: "/github/steering/result?steering=connected",
    titleKey: "steeringConnect",
  },
] as const;

/**
 * The signed-in rows whose path names a record seed:e2e minted with an id no
 * row can know ahead of time: the seeded run.
 */
export function seededRoutes(record: SeedRecord): readonly RouteRow[] {
  return [
    { path: `/${org}/${ws}/runs/${record.runPublicId}`, titleKey: "run" },
  ];
}

/**
 * The rows the oracle walks with no session at all.
 *
 * `/cli/complete` is the end of `oxagen login`: the CLI's loopback listener
 * 302s the browser there once it holds its token, and that browser may carry no
 * app cookie at all. A row here is walked in a fresh context, so it fails on
 * the redirect to /login that a gated route produces (#3091). The sign-in pages
 * are public too (src/proxy.ts PUBLIC_PATHS). An invitation token nothing
 * issued shows the invitation's not-found heading and title.
 */
export const ANONYMOUS_ROUTES: readonly RouteRow[] = [
  { path: "/cli/complete", titleKey: "cliComplete" },
  { path: "/login", titleKey: "login" },
  // Sign-up's tab names the page by its eyebrow (ARCHITECTURE.md §1.2).
  { path: "/signup", title: auth.auth.signup.eyebrow },
  { path: "/verify", titleKey: "verify" },
  { path: "/forgot-password", titleKey: "forgotPassword" },
  { path: "/reset-password", titleKey: "resetPassword" },
  { path: "/invite/e2e-no-such-token", titleKey: "invitationNotFound" },
] as const;

/** The signed-in row at `path`; a redirect row lands on a page the oracle walks. */
function walked(path: string): RouteRow {
  const row = SIGNED_IN_ROUTES.find((candidate) => candidate.path === path);
  if (row === undefined) {
    throw new Error(`e2e/routes.ts: no signed-in row walks ${path}`);
  }
  return row;
}

/**
 * The pages that render nothing of their own and only move the browser on,
 * walked signed in. Each lands on a signed-in row, so the walk holds it to that
 * row's path and title.
 */
export const REDIRECT_ROUTES: readonly RedirectRow[] = [
  // The landing: the first workspace of the owner's first organization.
  { path: "/", landsOn: walked(`/${org}/${ws}`) },
  // The design's name for onboarding step 1 forwards to the page that has it.
  { path: "/welcome/organization", landsOn: walked("/new-organization") },
  // Runtimes and Tools are tabs of Agents; Skills is a shelf of Steering.
  {
    path: `/${org}/${ws}/runtimes`,
    landsOn: walked(`/${org}/${ws}/agents?tab=runtimes`),
  },
  {
    path: `/${org}/${ws}/tools`,
    landsOn: walked(`/${org}/${ws}/agents?tab=mcp-servers`),
  },
  {
    path: `/${org}/${ws}/skills`,
    landsOn: walked(`/${org}/${ws}/steering/skills`),
  },
  {
    path: `/${org}/${ws}/skills/catalog`,
    landsOn: walked(`/${org}/${ws}/steering/skills`),
  },
] as const;

/**
 * The document title a row must produce, per the root layout's template. A
 * work item's page names the item before the page, `WI-1 · Work item`, from
 * the last segment of its path (the item route's generateMetadata).
 */
export function expectedTitle(row: RouteRow): string {
  if ("title" in row) return `${row.title} · ${pages.app.name}`;
  const page = pages.pages[row.titleKey];
  const name =
    row.titleKey === "workItem"
      ? `${row.path.slice(row.path.lastIndexOf("/") + 1)} · ${page}`
      : page;
  return `${name} · ${pages.app.name}`;
}
