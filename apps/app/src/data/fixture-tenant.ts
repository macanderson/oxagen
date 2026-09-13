// The fixture demo record's tenant ids (Acme Robotics), taken from the fixture
// tenancy lane L4 resolves viewers against (src/server/fixture-tenancy.ts), so
// the scope `requireViewer` builds in fixture mode is the scope the fixture
// adapter filters workspace reads by. Ids only, no demo data.
import { FIXTURE_ORG, FIXTURE_WORKSPACES } from "@/server/fixture-tenancy";

export type FixtureWorkspaceSlug = "core-platform" | "finops";

function workspaceId(slug: FixtureWorkspaceSlug): string {
  const found = FIXTURE_WORKSPACES.find((w) => w.slug === slug);
  if (!found) throw new Error(`fixture tenancy has no workspace ${slug}`);
  return found.id;
}

export const FIXTURE_TENANT = {
  orgSlug: FIXTURE_ORG.slug,
  orgId: FIXTURE_ORG.id,
  workspaces: {
    "core-platform": workspaceId("core-platform"),
    finops: workspaceId("finops"),
  },
} as const;

/** The fixture workspace slug a scope names, or null for org-level and unknown scopes. */
export function fixtureWorkspaceSlug(id: string): FixtureWorkspaceSlug | null {
  for (const [slug, candidate] of Object.entries(FIXTURE_TENANT.workspaces)) {
    if (candidate === id) return slug as FixtureWorkspaceSlug;
  }
  return null;
}
