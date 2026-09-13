// The fixture demo record's tenant ids (Acme Robotics). The fixture adapter
// scopes workspace reads by these, so the fixture viewer lane L4 builds for
// MC_DATA=fixture must put the same ids on `Scope`. Safe to import anywhere:
// ids only, no demo data.
export const FIXTURE_TENANT = {
  orgSlug: "acme",
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaces: {
    "core-platform": "0192d4a8-7c1e-7a00-8000-0000000c0e01",
    finops: "0192d4a8-7c1e-7a00-8000-00000000f1e0",
  },
} as const;

export type FixtureWorkspaceSlug = keyof typeof FIXTURE_TENANT.workspaces;

/** The fixture workspace slug a scope names, or null for org-level and unknown scopes. */
export function fixtureWorkspaceSlug(
  workspaceId: string,
): FixtureWorkspaceSlug | null {
  for (const [slug, id] of Object.entries(FIXTURE_TENANT.workspaces)) {
    if (id === workspaceId) return slug as FixtureWorkspaceSlug;
  }
  return null;
}
