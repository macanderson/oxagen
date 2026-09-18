// Every static org-level route segment must be a reserved workspace slug.
//
// A workspace lives at `/{org}/{ws}` and an organization page at
// `/{org}/<segment>`. Next.js resolves a static segment ahead of a dynamic
// one, so the moment an org page takes a segment that a workspace slug can
// also take, that workspace's root URL opens the org page instead — silently,
// with no redirect and no error. `shared/legacy-routes.ts` already states this
// invariant in its header ("Every two-segment organization row's segment is in
// RESERVED_WORKSPACE_SLUGS ... so no row shadows a workspace's Fleet page"),
// and `create_org` has always enforced it for the first workspace.
//
// Nothing enforced it for the ROUTES. The check that existed lived in
// `packages/oxagen/src/contracts/org.create.test.ts` as a hand-written list,
// `["api-keys", "billing", "audit"]` — so when #3110 added `/{org}/roles` the
// list was simply not updated and nothing failed. A hand-maintained copy of a
// directory listing is not an invariant; it is a second thing to forget.
//
// This test reads the real route directory instead, so a page added at a
// segment nobody reserved fails here rather than shadowing a customer's
// workspace in production.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_WORKSPACE_SLUGS } from "@oxagen/oxagen/contracts/org.create";

const ORG_ROUTE_DIR = join(process.cwd(), "src", "app", "[org]");

/**
 * The static child segments of `/[org]` — the directories that are real URL
 * segments. Dynamic segments (`[ws]`), route groups (`(auth)`) and private
 * folders (`_lib`) are not URL segments and cannot shadow anything.
 */
function staticOrgRouteSegments(): string[] {
  return readdirSync(ORG_ROUTE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        !name.startsWith("[") && !name.startsWith("(") && !name.startsWith("_"),
    )
    .sort();
}

describe("static org route segments", () => {
  it("finds the segments on disk, so this test cannot pass by reading nothing", () => {
    const segments = staticOrgRouteSegments();
    expect(segments.length).toBeGreaterThan(0);
    // The ones shipped at the time of writing. A new page adds to this and the
    // reserved-set assertion below is what has to be satisfied, not this list.
    expect(segments).toEqual(
      expect.arrayContaining([
        "api-keys",
        "audit",
        "billing",
        "model-funding",
        "roles",
      ]),
    );
  });

  it.each(staticOrgRouteSegments())(
    "/[org]/%s is a reserved workspace slug",
    (segment) => {
      expect(
        RESERVED_WORKSPACE_SLUGS.has(segment),
        `/{org}/${segment} is a static route, so a workspace with the slug "${segment}" would be unreachable at its own URL. Add "${segment}" to RESERVED_WORKSPACE_SLUGS in packages/oxagen/src/workspace-slug.ts.`,
      ).toBe(true);
    },
  );

  it("does not treat the dynamic workspace segment as a reserved slug", () => {
    // `[ws]` is the workspace route itself, not a competitor for its slug.
    expect(staticOrgRouteSegments()).not.toContain("[ws]");
  });
});
