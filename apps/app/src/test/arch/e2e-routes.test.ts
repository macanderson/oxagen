// INV-20 (ARCHITECTURE.md §4, §6.3), the route-set clause: the page-load
// oracle walks every page. Each `page.tsx` under src/app is reached by a row of
// e2e/routes.ts (signed in, anonymous, seeded or a redirect), or is named in
// UNWALKED below with the reason the oracle cannot open it.
//
// A row's path is resolved to the one page Next serves for it: a static
// segment beats a dynamic one, a dynamic one beats a catch-all, and a
// catch-all beats an optional catch-all. So `/new-organization` reaches its
// own page and not `[org]`, and a row cannot claim a page it only resembles.
// The query is not part of the match. A row whose path reaches no page fails,
// and so does an exception that a row walks or that names no page.
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_ROUTES,
  REDIRECT_ROUTES,
  SIGNED_IN_ROUTES,
  seededRoutes,
} from "../../../e2e/routes";
import { listFiles } from "./parse";

const RULE = "e2e-routes";
const APP_ROUTES = "src/app";

/** The pages the oracle does not walk, each with the reason it cannot. */
const UNWALKED: Readonly<Record<string, string>> = {
  "src/app/[org]/[ws]/mandates/[mandate]/page.tsx":
    "seed:e2e grants no mandate, and a mandate id nothing holds is a 404",
  "src/app/[org]/[ws]/steering/records/[lineage]/page.tsx":
    "seed:e2e publishes no steering record, and a lineage nothing holds is a 404",
  "src/app/[org]/[ws]/steering/proposals/prs/[proposal]/page.tsx":
    "seed:e2e opens no steering proposal, and a proposal id nothing holds is a 404",
  "src/app/[org]/[ws]/runtimes/[runtime]/page.tsx":
    "redirect only, to one runtime's drawer on the Agents page, and seed.json names no runtime id",
};

type Segment =
  | { readonly kind: "static"; readonly name: string }
  | { readonly kind: "dynamic" }
  | { readonly kind: "catchAll" }
  | { readonly kind: "optionalCatchAll" };

/** A page file and the URL segments its directories name. */
type PageRoute = { readonly page: string; readonly segments: Segment[] };

/** Next's order when several pages match one path: the higher rank wins. */
const RANK: Readonly<Record<Segment["kind"], number>> = {
  static: 3,
  dynamic: 2,
  catchAll: 1,
  optionalCatchAll: 0,
};

function segmentOf(dir: string): Segment {
  if (dir.startsWith("[[...") && dir.endsWith("]]")) {
    return { kind: "optionalCatchAll" };
  }
  if (dir.startsWith("[...") && dir.endsWith("]")) return { kind: "catchAll" };
  if (dir.startsWith("[") && dir.endsWith("]")) return { kind: "dynamic" };
  return { kind: "static", name: dir };
}

/**
 * `src/app/(auth)/invite/[token]/page.tsx` → `invite`, then a dynamic
 * segment. A route group names no segment.
 */
function pageRoute(page: string): PageRoute {
  const dirs = page
    .slice(APP_ROUTES.length + 1)
    .split("/")
    .slice(0, -1)
    .filter((dir) => !(dir.startsWith("(") && dir.endsWith(")")));
  return { page, segments: dirs.map(segmentOf) };
}

function matches(
  pattern: readonly Segment[],
  parts: readonly string[],
): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return parts.length === 0;
  switch (head.kind) {
    case "static":
      return parts[0] === head.name && matches(rest, parts.slice(1));
    case "dynamic":
      return parts.length > 0 && matches(rest, parts.slice(1));
    case "catchAll":
      return parts.length > 0;
    case "optionalCatchAll":
      return true;
  }
}

/** Negative when `a` is the more specific pattern, segment by segment. */
function bySpecificity(a: readonly Segment[], b: readonly Segment[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    const diff =
      (right === undefined ? -1 : RANK[right.kind]) -
      (left === undefined ? -1 : RANK[left.kind]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The page Next serves for `path`, or null when no page matches it. */
function resolvePage(
  path: string,
  routes: readonly PageRoute[],
): string | null {
  const pathname = path.split("?", 1)[0] ?? "";
  const parts = pathname.split("/").filter((part) => part !== "");
  const [best] = routes
    .filter((route) => matches(route.segments, parts))
    .sort((a, b) => bySpecificity(a.segments, b.segments));
  return best?.page ?? null;
}

/**
 * Violations of the route-set clause: each path that reaches no page, each
 * page no path reaches and no exception names, each exception a path reaches,
 * and each exception that names no page.
 */
function oracleViolations(
  routes: readonly PageRoute[],
  paths: readonly string[],
  unwalked: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  const reached = new Set<string>();
  for (const path of paths) {
    const page = resolvePage(path, routes);
    if (page === null) out.push(`${RULE} ${path} reaches-no-page`);
    else reached.add(page);
  }
  for (const { page } of routes) {
    const excepted = Object.hasOwn(unwalked, page);
    if (excepted && reached.has(page)) {
      out.push(`${RULE} ${page} walked-exception`);
    } else if (!excepted && !reached.has(page)) {
      out.push(`${RULE} ${page} no-row`);
    }
  }
  for (const page of Object.keys(unwalked)) {
    if (!routes.some((route) => route.page === page)) {
      out.push(`${RULE} ${page} exception-names-no-page`);
    }
  }
  return out.sort();
}

/**
 * Every path the oracle opens. The seeded run's id is unknown here, and any
 * id reaches the same page.
 */
const WALKED_PATHS: readonly string[] = [
  ...SIGNED_IN_ROUTES.map((row) => row.path),
  ...seededRoutes({ runPublicId: "arun_e2e" }).map((row) => row.path),
  ...ANONYMOUS_ROUTES.map((row) => row.path),
  ...REDIRECT_ROUTES.map((row) => row.path),
];

const APP_PAGES: readonly PageRoute[] = listFiles(APP_ROUTES)
  .filter((file) => file.endsWith("/page.tsx"))
  .map(pageRoute);

describe("e2e routes (INV-20)", () => {
  it("every page.tsx is walked by a row or named as an exception", () => {
    expect(APP_PAGES.length).toBeGreaterThan(0);
    expect(oracleViolations(APP_PAGES, WALKED_PATHS, UNWALKED)).toEqual([]);
  });

  it("no two rows walk the same path", () => {
    const repeated = WALKED_PATHS.filter(
      (path, at) => WALKED_PATHS.indexOf(path) !== at,
    );
    expect(repeated).toEqual([]);
  });

  it("every redirect row lands on a signed-in row", () => {
    const strays = REDIRECT_ROUTES.filter(
      (row) => !SIGNED_IN_ROUTES.includes(row.landsOn),
    ).map((row) => row.path);
    expect(strays).toEqual([]);
  });
});

// --- Probes -----------------------------------------------------------------
//
// A small page set, judged as the app's own is, so each clause is seen to fail.

const PROBE_PAGES: readonly PageRoute[] = [
  "src/app/page.tsx",
  "src/app/[org]/page.tsx",
  "src/app/(onboarding)/new-organization/page.tsx",
  "src/app/[org]/[ws]/page.tsx",
  "src/app/[org]/[ws]/runs/[run]/page.tsx",
  "src/app/[org]/[ws]/skills/[...rest]/page.tsx",
  "src/app/[org]/[ws]/skills/catalog/page.tsx",
  "src/app/[org]/[ws]/tools/[[...tab]]/page.tsx",
].map(pageRoute);

describe("e2e routes probes", () => {
  it("serves a static segment over a dynamic one", () => {
    expect(resolvePage("/new-organization", PROBE_PAGES)).toBe(
      "src/app/(onboarding)/new-organization/page.tsx",
    );
    expect(resolvePage("/acme", PROBE_PAGES)).toBe("src/app/[org]/page.tsx");
  });

  it("serves a static segment over a catch-all, and the catch-all below it", () => {
    expect(resolvePage("/acme/core/skills/catalog", PROBE_PAGES)).toBe(
      "src/app/[org]/[ws]/skills/catalog/page.tsx",
    );
    expect(resolvePage("/acme/core/skills/search", PROBE_PAGES)).toBe(
      "src/app/[org]/[ws]/skills/[...rest]/page.tsx",
    );
    expect(resolvePage("/acme/core/skills", PROBE_PAGES)).toBeNull();
  });

  it("serves an optional catch-all for its bare path, and leaves the query out", () => {
    expect(resolvePage("/acme/core/tools", PROBE_PAGES)).toBe(
      "src/app/[org]/[ws]/tools/[[...tab]]/page.tsx",
    );
    expect(resolvePage("/acme/core/tools/servers/x?tab=a", PROBE_PAGES)).toBe(
      "src/app/[org]/[ws]/tools/[[...tab]]/page.tsx",
    );
    expect(resolvePage("/", PROBE_PAGES)).toBe("src/app/page.tsx");
  });

  it("fails a page no row walks", () => {
    expect(
      oracleViolations(
        PROBE_PAGES,
        [
          "/",
          "/acme",
          "/new-organization",
          "/acme/core",
          "/acme/core/skills/search",
          "/acme/core/skills/catalog",
          "/acme/core/tools",
        ],
        {},
      ),
    ).toEqual([`${RULE} src/app/[org]/[ws]/runs/[run]/page.tsx no-row`]);
  });

  it("fails a row that reaches no page", () => {
    expect(oracleViolations(PROBE_PAGES, ["/acme/core/skills"], {})).toContain(
      `${RULE} /acme/core/skills reaches-no-page`,
    );
  });

  it("fails an exception a row walks, and one that names no page", () => {
    const found = oracleViolations(PROBE_PAGES, ["/acme/core/runs/arun_1"], {
      "src/app/[org]/[ws]/runs/[run]/page.tsx": "probe",
      "src/app/gone/page.tsx": "probe",
    });
    expect(found).toContain(
      `${RULE} src/app/[org]/[ws]/runs/[run]/page.tsx walked-exception`,
    );
    expect(found).toContain(
      `${RULE} src/app/gone/page.tsx exception-names-no-page`,
    );
  });
});
