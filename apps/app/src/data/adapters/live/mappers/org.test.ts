// Contract tests for the organization row mappers: representative rows typed
// from the drizzle schema ($inferSelect) and the agent tool outputs, mapped and
// parsed through the view models. Each unrecorded field is proven to settle as
// "not recorded", and a widened view (the promote list's contract change)
// proves the recorded rest of the row parses.
import type { schema } from "@oxagen/database";
import type { OrgDataPlaneGetOutput } from "@oxagen/oxagen/contracts/org.data_plane.get";
import type { OrgModelCredentialGetOutput } from "@oxagen/oxagen/contracts/org.model_credential.get";
import type { OrgSettingsReadOutput } from "@oxagen/oxagen/contracts/org.settings.read";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiKey,
  Count,
  Currency,
  DataPlane,
  Day,
  Invitation,
  Member,
  ModelFunding,
  Money,
  Organization,
  OrgRole,
  PublicId,
  Workspace,
  WorkspaceRole,
} from "@/data/contracts";
import {
  API_KEY_EXPIRING_WITHIN_DAYS,
  apiKeyStatus,
  creditsAsMoney,
  day,
  instant,
  orgRoleOf,
  settle,
  toApiKey,
  toDataPlane,
  toInvitation,
  toMember,
  toModelFunding,
  toOrganization,
  toWorkspace,
  workspaceRoleOf,
} from "./org";

const NOW = new Date("2026-09-12T10:00:00.000Z");
const ORG_ID = "0192d4a8-7c1e-7a00-8000-00000000ac3e";

const userRow: typeof schema.users.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000b1",
  publicId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
  createdAt: new Date("2026-03-01T09:00:00.000Z"),
  updatedAt: new Date("2026-03-01T09:00:00.000Z"),
  createdByUserId: null,
  updatedByUserId: null,
  deletedAt: null,
  deletedByUserId: null,
  email: "marcus.bell@acme.test",
  displayName: "Marcus Bell",
  avatarUrl: null,
  status: "active",
  emailVerified: true,
  twoFactorEnabled: true,
};

const orgUserRow: typeof schema.orgUsers.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000c1",
  publicId: "oru_3h8k2m9q4x1c8v5b3n6z0p",
  createdAt: new Date("2026-03-01T09:00:00.000Z"),
  updatedAt: new Date("2026-03-01T09:00:00.000Z"),
  createdByUserId: null,
  updatedByUserId: null,
  orgId: ORG_ID,
  userId: userRow.id,
  // The IAM role-change path writes TitleCase.
  role: "Admin",
  joinedAt: new Date("2026-03-01T09:00:00.000Z"),
};

const workspaceRow: typeof schema.workspaces.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000d1",
  publicId: "wrk_1c8v5b3n6z0p2r7m2k9q4x",
  createdAt: new Date("2026-03-02T09:00:00.000Z"),
  updatedAt: new Date("2026-03-02T09:00:00.000Z"),
  createdByUserId: userRow.id,
  updatedByUserId: null,
  orgId: ORG_ID,
  name: "Core Platform",
  slug: "core-platform",
  namespace: "core",
  avatarUrl: null,
  description: null,
  promptConfig: {},
  settings: {},
  defaultTextTier: null,
  defaultTextModel: null,
};

const workspaceUserRow: typeof schema.workspaceUsers.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000e1",
  publicId: "wsu_5b3n6z0p2r7m2k9q4x1c8v",
  createdAt: new Date("2026-03-02T09:00:00.000Z"),
  updatedAt: new Date("2026-03-02T09:00:00.000Z"),
  createdByUserId: null,
  updatedByUserId: null,
  workspaceId: workspaceRow.id,
  userId: userRow.id,
  role: "owner",
  joinedAt: new Date("2026-03-02T09:00:00.000Z"),
};

const invitationRow: typeof schema.invitations.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000f1",
  publicId: "invi_6z0p2r7m2k9q4x1c8v5b3n",
  createdAt: new Date("2026-09-08T14:30:00.000Z"),
  updatedAt: new Date("2026-09-08T14:30:00.000Z"),
  createdByUserId: userRow.id,
  updatedByUserId: userRow.id,
  orgId: ORG_ID,
  email: "priya.nair@acme.test",
  role: "Member",
  status: "pending",
  invitedByUserId: userRow.id,
  acceptedUserId: null,
  expiresAt: new Date("2026-09-15T14:30:00.000Z"),
};

const apiKeyRow: typeof schema.apiKeys.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  publicId: "aky_2r7m2k9q4x1c8v5b3n6z0p",
  createdAt: new Date("2026-06-01T09:00:00.000Z"),
  updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  createdByUserId: userRow.id,
  updatedByUserId: null,
  orgId: ORG_ID,
  workspaceId: workspaceRow.id,
  deletedAt: null,
  deletedByUserId: null,
  keyPrefix: "oxk_live_4f9a",
  keyHash: "sha256:never-read-by-the-mapper",
  name: "ci-deployer",
  scope: {},
  stellaTelemetryEnrollmentId: null,
  stellaTelemetryEnrolledAt: null,
  expiresAt: new Date("2027-06-01T09:00:00.000Z"),
  lastUsedAt: new Date("2026-09-11T22:04:10.000Z"),
};

/** The widened views the promote list asks for: each unrecorded field nullable. */
const widened = {
  Organization: Organization.extend({
    plan: Organization.shape.plan.nullable(),
    displayCurrency: Currency.nullable(),
    billingCurrency: Currency.nullable(),
    deploymentMode: Organization.shape.deploymentMode.nullable(),
    region: z.string().nullable(),
    governanceMode: Organization.shape.governanceMode.nullable(),
    attesterKeyId: z.string().nullable(),
  }),
  Workspace: Workspace.extend({
    mainRepo: z.string().nullable(),
    productionBranch: z.string().nullable(),
    linkedRepos: z.array(z.string()).nullable(),
    agentCount: Count.nullable(),
    ownerId: PublicId.nullable(),
  }),
  ApiKey: ApiKey.extend({
    principal: z.string().nullable(),
    grants: z.array(z.string()).min(1).nullable(),
    createdById: PublicId.nullable(),
    uses30d: Count.nullable(),
    expiresOn: Day.nullable(),
  }),
  DataPlane: DataPlane.extend({
    store: DataPlane.shape.store.nullable(),
    status: DataPlane.shape.status.nullable(),
    region: z.string().nullable(),
    isolation: z.string().nullable(),
  }),
  ModelFunding: ModelFunding.extend({
    monthlyCap: Money.nullable(),
    routes: ModelFunding.shape.routes.nullable(),
  }),
};

describe("scalars", () => {
  it("writes instants and days in UTC", () => {
    const at = new Date("2026-09-11T23:59:59.123Z");
    expect(instant(at)).toBe("2026-09-11T23:59:59.123Z");
    expect(day(at)).toBe("2026-09-11");
  });

  it("lowercases either stored casing onto the spec roles", () => {
    expect(orgRoleOf("Owner")).toBe("owner");
    expect(orgRoleOf("compliance")).toBe("compliance");
    expect(workspaceRoleOf("Viewer")).toBe("viewer");
  });

  it("leaves a role outside the spec vocabulary null, never a nearest guess", () => {
    expect(orgRoleOf("superuser")).toBeNull();
    // The CHECK admits `admin` on workspace_users; the spec's workspace roles do not.
    expect(workspaceRoleOf("Admin")).toBeNull();
  });

  it("turns credit cents into micro-USD without a float", () => {
    expect(creditsAsMoney(2000)).toEqual({
      micros: "20000000",
      currency: "USD",
    });
    expect(creditsAsMoney(9_007_199_254_740_993n)).toEqual({
      micros: "90071992547409930000",
      currency: "USD",
    });
    expect(Money.safeParse(creditsAsMoney(0)).success).toBe(true);
  });
});

describe("toMember", () => {
  const source = {
    membership: { role: orgUserRow.role, joinedAt: orgUserRow.joinedAt },
    user: {
      publicId: userRow.publicId,
      twoFactorEnabled: userRow.twoFactorEnabled,
    },
    workspaces: [
      { slug: "zeta-lab", role: "Viewer" },
      { slug: workspaceRow.slug, role: workspaceUserRow.role },
    ],
    lastSessionAt: new Date("2026-09-12T08:41:00.000Z"),
  };

  it("parses a real org_users ⨝ users row through Member", () => {
    const member = Member.parse(toMember(source));
    expect(member).toEqual({
      personId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
      role: "admin",
      workspaces: [
        { slug: "core-platform", role: "owner" },
        { slug: "zeta-lab", role: "viewer" },
      ],
      allWorkspaces: false,
      status: "active",
      lastActiveAt: "2026-09-12T08:41:00.000Z",
      mfa: ["totp"],
      sso: null,
    });
  });

  it("records no factor and no activity as empty and null, not invented", () => {
    const member = Member.parse(
      toMember({
        ...source,
        user: { ...source.user, twoFactorEnabled: false },
        workspaces: [],
        lastSessionAt: null,
      }),
    );
    expect(member.mfa).toEqual([]);
    expect(member.lastActiveAt).toBeNull();
    expect(member.workspaces).toEqual([]);
  });

  it("settles a membership role the spec cannot name as not recorded", () => {
    const draft = toMember({
      ...source,
      workspaces: [{ slug: "core-platform", role: "billing" }],
    });
    expect(settle(Member, [draft])).toEqual({
      kind: "unrecorded",
      paths: ["workspaces.role"],
    });
  });
});

describe("toInvitation", () => {
  const source = {
    invitation: {
      email: invitationRow.email,
      role: invitationRow.role,
      createdAt: invitationRow.createdAt,
      expiresAt: invitationRow.expiresAt,
    },
    inviterPublicId: userRow.publicId,
  };

  it("parses a real pending invitation through Invitation", () => {
    expect(Invitation.parse(toInvitation(source))).toEqual({
      email: "priya.nair@acme.test",
      role: { scope: "org", role: "member" },
      invitedById: "usr_7m2k9q4x1c8v5b3n6z0p2r",
      sentOn: "2026-09-08",
      expiresOn: "2026-09-15",
    });
  });

  it("settles a legacy row with no expiry or no inviter as not recorded", () => {
    const drafts = [
      toInvitation({
        ...source,
        invitation: { ...source.invitation, expiresAt: null },
      }),
      toInvitation({ ...source, inviterPublicId: null }),
    ];
    expect(settle(Invitation, drafts)).toEqual({
      kind: "unrecorded",
      paths: ["expiresOn", "invitedById"],
    });
  });
});

describe("toWorkspace", () => {
  const source = {
    workspace: { slug: workspaceRow.slug, name: workspaceRow.name },
    agentCount: 3,
    ownerPublicId: userRow.publicId,
  };

  it("leaves the repository fields unrecorded rather than guessing a main repo", () => {
    expect(settle(Workspace, [toWorkspace(source)])).toEqual({
      kind: "unrecorded",
      paths: ["linkedRepos", "mainRepo", "productionBranch"],
    });
  });

  it("parses the recorded rest once the repository fields are nullable", () => {
    expect(widened.Workspace.parse(toWorkspace(source))).toEqual({
      slug: "core-platform",
      name: "Core Platform",
      mainRepo: null,
      productionBranch: null,
      linkedRepos: null,
      agentCount: 3,
      ownerId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
    });
  });

  it("never counts an unread workspace as zero agents", () => {
    const draft = toWorkspace({ ...source, agentCount: null });
    expect(draft.agentCount).toBeNull();
    expect(settle(Workspace, [draft])).toMatchObject({
      kind: "unrecorded",
      paths: expect.arrayContaining(["agentCount"]),
    });
  });
});

describe("toApiKey", () => {
  const source = {
    key: {
      name: apiKeyRow.name,
      keyPrefix: apiKeyRow.keyPrefix,
      lastUsedAt: apiKeyRow.lastUsedAt,
      expiresAt: apiKeyRow.expiresAt,
    },
    creatorPublicId: userRow.publicId,
  };

  it("masks to the stored prefix and never carries the hash", () => {
    const draft = toApiKey(source, NOW);
    expect(draft.maskedKey).toBe("oxk_live_4f9a…");
    expect(JSON.stringify(draft)).not.toContain(apiKeyRow.keyHash);
  });

  it("settles principal, grants and use count as not recorded", () => {
    expect(settle(ApiKey, [toApiKey(source, NOW)])).toEqual({
      kind: "unrecorded",
      paths: ["grants", "principal", "uses30d"],
    });
  });

  it("parses the recorded rest once those fields are nullable", () => {
    expect(widened.ApiKey.parse(toApiKey(source, NOW))).toEqual({
      name: "ci-deployer",
      maskedKey: "oxk_live_4f9a…",
      principal: null,
      grants: null,
      createdById: "usr_7m2k9q4x1c8v5b3n6z0p2r",
      lastUsedAt: "2026-09-11T22:04:10.000Z",
      uses30d: null,
      expiresOn: "2027-06-01",
      status: "ok",
    });
  });

  it("derives status from expiry first, then use", () => {
    const soon = new Date(
      NOW.getTime() + API_KEY_EXPIRING_WITHIN_DAYS * 86_400_000,
    );
    const later = new Date(soon.getTime() + 1);
    expect(apiKeyStatus({ expiresAt: soon, lastUsedAt: null }, NOW)).toBe(
      "expiring",
    );
    expect(apiKeyStatus({ expiresAt: later, lastUsedAt: null }, NOW)).toBe(
      "unused",
    );
    expect(apiKeyStatus({ expiresAt: null, lastUsedAt: NOW }, NOW)).toBe("ok");
  });
});

describe("toDataPlane", () => {
  const binding = (
    over: Partial<OrgDataPlaneGetOutput>,
  ): OrgDataPlaneGetOutput => ({
    kind: "postgres",
    mode: "shared",
    status: "active",
    host: null,
    database: null,
    schemaVersion: null,
    lastVerifiedAt: null,
    rotatedAt: null,
    ...over,
  });

  it("maps the store's words onto the spec's and leaves region and isolation unrecorded", () => {
    const drafts = [
      binding({}),
      binding({ kind: "neo4j", mode: "dedicated", status: "degraded" }),
    ].map(toDataPlane);
    expect(settle(DataPlane, drafts)).toEqual({
      kind: "unrecorded",
      paths: ["isolation", "region"],
    });
    expect(widened.DataPlane.array().parse(drafts)).toEqual([
      {
        store: "postgres",
        mode: "shared",
        status: "active",
        region: null,
        isolation: null,
      },
      {
        store: "neo4j",
        mode: "dedicated",
        status: "degraded",
        region: null,
        isolation: null,
      },
    ]);
  });

  it("leaves a clickhouse plane and a disabled status null, not renamed", () => {
    const draft = toDataPlane(
      binding({ kind: "clickhouse", status: "disabled" }),
    );
    expect(draft.store).toBeNull();
    expect(draft.status).toBeNull();
  });
});

describe("toModelFunding", () => {
  const credential = (
    over: Partial<OrgModelCredentialGetOutput>,
  ): OrgModelCredentialGetOutput => ({
    configured: true,
    provider: "openrouter",
    status: "active",
    keyHint: "9f2c",
    lastVerifiedAt: null,
    rotatedAt: null,
    ...over,
  });

  it("names the customer's key only while one is stored and active", () => {
    const fund = (c: OrgModelCredentialGetOutput) =>
      toModelFunding({ credential: c, capCents: 2000, spentCents: 0n }).source;
    expect(fund(credential({}))).toBe("customer_key");
    expect(fund(credential({ status: "disabled" }))).toBe("platform");
    expect(
      fund(credential({ configured: false, provider: null, status: null })),
    ).toBe("platform");
  });

  it("settles routes as not recorded, and parses cap and spend as money once nullable", () => {
    const draft = toModelFunding({
      credential: credential({
        configured: false,
        provider: null,
        status: null,
      }),
      capCents: 2000,
      spentCents: 1234n,
    });
    expect(settle(ModelFunding, [draft])).toEqual({
      kind: "unrecorded",
      paths: ["routes"],
    });
    expect(widened.ModelFunding.parse(draft)).toEqual({
      source: "platform",
      monthlyCap: { micros: "20000000", currency: "USD" },
      usedThisMonth: { micros: "12340000", currency: "USD" },
      routes: null,
    });
  });

  it("shows no cap as unrecorded money, never as a zero cap", () => {
    const draft = toModelFunding({
      credential: credential({}),
      capCents: null,
      spentCents: 0n,
    });
    expect(draft.monthlyCap).toBeNull();
  });
});

describe("toOrganization", () => {
  const settings: OrgSettingsReadOutput = {
    name: "Acme Robotics",
    slug: "acme",
    avatarUrl: null,
    website: "https://acme.test",
    industry: null,
    employeeSize: "201-500",
    type: "business",
  };

  it("leaves every column the organization row lacks unrecorded", () => {
    expect(
      settle(Organization, [toOrganization({ settings, tier: "enterprise" })]),
    ).toEqual({
      kind: "unrecorded",
      paths: [
        "attesterKeyId",
        "billingCurrency",
        "deploymentMode",
        "displayCurrency",
        "governanceMode",
        "region",
      ],
    });
  });

  it("maps free and enterprise, and leaves build and scale unnamed", () => {
    expect(toOrganization({ settings, tier: "free" }).plan).toBe("free");
    expect(toOrganization({ settings, tier: "build" }).plan).toBeNull();
    expect(toOrganization({ settings, tier: "scale" }).plan).toBeNull();
    expect(
      widened.Organization.parse(
        toOrganization({ settings, tier: "enterprise" }),
      ),
    ).toMatchObject({
      slug: "acme",
      name: "Acme Robotics",
      plan: "enterprise",
    });
  });
});

describe("settle", () => {
  const View = z.object({ role: OrgRole, count: Count });

  it("returns every parsed row when all drafts fit", () => {
    expect(
      settle(View, [
        { role: "owner", count: 1 },
        { role: "viewer", count: 0 },
      ]),
    ).toEqual({
      kind: "ok",
      value: [
        { role: "owner", count: 1 },
        { role: "viewer", count: 0 },
      ],
    });
  });

  it("calls a produced value the schema rejects a mismatch, even beside a null", () => {
    expect(settle(View, [{ role: null, count: -1 }])).toEqual({
      kind: "mismatch",
      paths: ["count"],
    });
  });

  it("settles an empty read as ok and empty", () => {
    expect(settle(WorkspaceRole, [])).toEqual({ kind: "ok", value: [] });
  });
});
