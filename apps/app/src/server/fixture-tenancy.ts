// Tenancy lookups for the fixture data source (MC_DATA=fixture, dev/e2e only).
//
// The mockup baseline's one organization (mc.html @ mc-baseline-w1: ORG, WS,
// MEMBERS): Acme Robotics with the core-platform and finops workspaces. The
// fixture operator, Marcus Bell, is an organization member who belongs to
// core-platform only, so /acme/finops exercises the non-member 404 in e2e the
// same way a live non-member does. One historical slug per level exercises the
// slug-history redirect.
//
// Selected only by `tenancyLookups()` in scope.ts behind isFixtureMode(), which
// is constant-false in a production build.
import { FIXTURE_USER } from "./fixture-session";
import type {
  OrgRecord,
  TenancyLookups,
  WorkspaceRecord,
} from "./tenancy-lookups";

export const FIXTURE_ORG: OrgRecord = {
  id: "6f1d2c3a-5b4e-4d10-8a01-00000000ac01",
  publicId: "org_acme",
  slug: "acme",
  name: "Acme Robotics",
};

export const FIXTURE_WORKSPACES: readonly WorkspaceRecord[] = [
  {
    id: "6f1d2c3a-5b4e-4d10-8a01-00000000c001",
    publicId: "wks_coreplatform",
    orgId: FIXTURE_ORG.id,
    slug: "core-platform",
    name: "Core platform",
  },
  {
    id: "6f1d2c3a-5b4e-4d10-8a01-00000000f002",
    publicId: "wks_finops",
    orgId: FIXTURE_ORG.id,
    slug: "finops",
    name: "FinOps",
  },
];

/** Renamed slugs that still redirect: old → current. */
export const FIXTURE_ORG_SLUG_HISTORY: Readonly<Record<string, string>> = {
  "acme-robotics": "acme",
};
export const FIXTURE_WORKSPACE_SLUG_HISTORY: Readonly<Record<string, string>> =
  { platform: "core-platform" };

/** userId → organization role (lowercase). */
const ORG_ROLES: Readonly<Record<string, string>> = {
  [FIXTURE_USER.id]: "member",
};

/** workspace slug → member user ids. */
const WORKSPACE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  "core-platform": [FIXTURE_USER.id],
  finops: [],
};

function workspace(orgId: string, slug: string): WorkspaceRecord | null {
  return (
    FIXTURE_WORKSPACES.find((w) => w.orgId === orgId && w.slug === slug) ?? null
  );
}

export const fixtureTenancyLookups: TenancyLookups = {
  orgBySlug: (slug) =>
    Promise.resolve(slug === FIXTURE_ORG.slug ? FIXTURE_ORG : null),
  orgBySlugHistory: (slug) =>
    Promise.resolve(
      FIXTURE_ORG_SLUG_HISTORY[slug] === FIXTURE_ORG.slug ? FIXTURE_ORG : null,
    ),
  workspaceBySlug: (orgId, slug) => Promise.resolve(workspace(orgId, slug)),
  workspaceBySlugHistory: (orgId, slug) => {
    const current = FIXTURE_WORKSPACE_SLUG_HISTORY[slug];
    return Promise.resolve(current ? workspace(orgId, current) : null);
  },
  orgRole: (orgId, userId) =>
    Promise.resolve(
      orgId === FIXTURE_ORG.id ? (ORG_ROLES[userId] ?? null) : null,
    ),
  isWorkspaceMember: (workspaceId, userId) => {
    const ws = FIXTURE_WORKSPACES.find((w) => w.id === workspaceId);
    return Promise.resolve(
      ws ? (WORKSPACE_MEMBERS[ws.slug] ?? []).includes(userId) : false,
    );
  },
  // The fixture organization has not opted into MFA enforcement.
  mfaPolicy: () => Promise.resolve(null),
  twoFactorEnabled: () => Promise.resolve(false),
};
