// The rev1 route table the page-load oracle walks (ARCHITECTURE.md §6.3).
//
// One row per signed-in rev1 surface: the path a person navigates to, and the
// `pages.*` key whose copy the page's generateMetadata returns. The root layout
// composes the document title as `%s · Oxagen` (src/app/layout.tsx), so a row
// asserts `<pages[titleKey]> · Oxagen` and nothing else — a page that renders an
// error boundary or a not-found keeps its own title, so the assertion fails
// rather than passing on a broken page.
//
// The table is data so the same rows can be read by the deploy verification
// (WL-52) against a real organization, not only by the e2e run against the seed.
//
// A page addressed by a record the seed mints (a mandate's `mnd_…` id) cannot
// be a static row, so its rows come from the seed record `seed:e2e` writes
// before Playwright starts. Without that file (a checkout that never seeded)
// the table carries the static rows alone; with it, a record missing the id
// is a broken seed and fails loudly rather than dropping the rows.
import { existsSync, readFileSync } from "node:fs";
import pages from "../messages/en.json" with { type: "json" };
import { SEED, SEED_RECORD } from "./support";

export type RouteRow = {
  /** The path to visit, with the seeded org and workspace already substituted. */
  readonly path: string;
  /** The `pages.*` key the page's generateMetadata returns. */
  readonly titleKey: keyof (typeof pages)["pages"];
};

const org = SEED.orgSlug;
const ws = SEED.workspaceSlug;

/** The seeded agent every seeded record belongs to (`seed/index.ts`). */
const SEEDED_AGENT = "e2e-agent";

/**
 * The rows for pages addressed by a record the seed minted: both Mandate
 * addresses, the flat one every surface links to and the design's nested one
 * (apps/app/ARCHITECTURE.md §1.2, the Mandate row).
 */
function seededRows(): RouteRow[] {
  if (!existsSync(SEED_RECORD)) return [];
  const record = JSON.parse(readFileSync(SEED_RECORD, "utf8")) as {
    mandatePublicId?: unknown;
  };
  const mandate = record.mandatePublicId;
  if (typeof mandate !== "string" || !/^mnd_[0-9a-z]+$/i.test(mandate)) {
    throw new Error(
      `${SEED_RECORD} carries no mandatePublicId; re-run pnpm --filter @oxagen/app seed:e2e`,
    );
  }
  return [
    { path: `/${org}/${ws}/mandates/${mandate}`, titleKey: "mandate" },
    {
      path: `/${org}/${ws}/agents/${SEEDED_AGENT}/mandates/${mandate}`,
      titleKey: "mandate",
    },
  ];
}

/** Every signed-in rev1 surface, in navigation order. */
export const SIGNED_IN_ROUTES: readonly RouteRow[] = [
  { path: `/${org}/${ws}`, titleKey: "fleet" },
  { path: `/${org}/${ws}/agents`, titleKey: "agents" },
  { path: `/${org}/${ws}/agents/${SEEDED_AGENT}/overview`, titleKey: "agent" },
  ...seededRows(),
  { path: `/${org}/${ws}/tools`, titleKey: "tools" },
  { path: `/${org}/${ws}/steering`, titleKey: "steering" },
  { path: `/${org}/${ws}/steering/library`, titleKey: "steering" },
  { path: `/${org}/${ws}/runtimes`, titleKey: "runtimes" },
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
  { path: "/new-organization", titleKey: "newOrganization" },
  { path: `/welcome/${org}/${ws}/wrap`, titleKey: "welcomeWrap" },
  { path: `/welcome/${org}/${ws}/run`, titleKey: "welcomeRun" },
  { path: `/welcome/${org}/${ws}/installer`, titleKey: "installer" },
] as const;

/**
 * The rows the oracle walks with no session at all.
 *
 * `/cli/complete` is the end of `oxagen login`: the CLI's loopback listener
 * 302s the browser there once it holds its token, and that browser may carry no
 * app cookie at all. A row here is walked in a fresh context, so it fails on
 * the redirect to /login that a gated route produces (#3091).
 */
export const ANONYMOUS_ROUTES: readonly RouteRow[] = [
  { path: "/cli/complete", titleKey: "cliComplete" },
] as const;

/** The document title a row must produce, per the root layout's template. */
export function expectedTitle(row: RouteRow): string {
  return `${pages.pages[row.titleKey]} · ${pages.app.name}`;
}
