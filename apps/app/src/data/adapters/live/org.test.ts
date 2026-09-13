// The live organization adapter: its guards (each with a negative case), how a
// read settles into a value, `not_backed`, `denied` or an error, the kernel seam
// it invokes agent tools through, and the tenant-scoped queries its store runs,
// against a fake transaction that records every query and the scope it ran in.
import type { OrgDataPlaneGetOutput } from "@oxagen/oxagen/contracts/org.data_plane.get";
import type { OrgModelCredentialGetOutput } from "@oxagen/oxagen/contracts/org.model_credential.get";
import type { OrgSettingsReadOutput } from "@oxagen/oxagen/contracts/org.settings.read";
import type { WorkspaceListOutput } from "@oxagen/oxagen/contracts/workspace.list";
import { getScope } from "@oxagen/tenancy";
import { getTableName, type Table } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  PublicId,
  Workspace,
} from "@/data/contracts";
import { BACKING } from "@/data/backing";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(
      readonly capability: string,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "CapabilityError";
    }
  }
  return {
    CapabilityError,
    registry: { loaded: 0 },
    invoke:
      vi.fn<
        (
          name: string,
          input: unknown,
          ctx: Record<string, unknown>,
        ) => Promise<unknown>
      >(),
    getCapability: vi.fn<(name: string) => unknown>(),
    getSession: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    orgRole: vi.fn<(orgId: string, userId: string) => Promise<string | null>>(),
    withTenantDb:
      vi.fn<(fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>>(),
    resolveOrgTier: vi.fn<(orgId: string) => Promise<string>>(),
    getOrgBillingSettings:
      vi.fn<
        (orgId: string) => Promise<{ assistantSpendCapCents: number | null }>
      >(),
    assistantSpendThisMonth: vi.fn<(orgId: string) => Promise<bigint>>(),
    captureError: vi.fn<(input: unknown) => void>(),
  };
});

vi.mock("@oxagen/handlers/register", () => {
  mocks.registry.loaded += 1;
  return {};
});
vi.mock("@oxagen/oxagen", () => ({
  CapabilityError: mocks.CapabilityError,
  invoke: mocks.invoke,
  getCapability: mocks.getCapability,
}));
vi.mock("@/server/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/server/tenancy-lookups", () => ({
  liveTenancyLookups: { orgRole: mocks.orgRole },
}));
vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.withTenantDb,
}));
vi.mock("@oxagen/billing", () => ({
  resolveOrgTier: mocks.resolveOrgTier,
  getOrgBillingSettings: mocks.getOrgBillingSettings,
  assistantSpendThisMonth: mocks.assistantSpendThisMonth,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: mocks.captureError }));

import { schema } from "@oxagen/database";
import {
  allows,
  createLiveOrg,
  isCapabilityDenial,
  kernelOrgInvoke,
  liveOrg,
  liveOrgDeps,
  ORG_RECORD_UNMAPPABLE,
  type OrgInvoke,
  type OrgLiveDeps,
  type OrgViews,
  type OrgStore,
  postgresOrgStore,
  reportToTelemetry,
} from "./org";

const ORG_ID = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS_A = "0192d4a8-7c1e-7a00-8000-0000000000d1";
const WS_B = "0192d4a8-7c1e-7a00-8000-0000000000d2";
const USER_ID = "0192d4a8-7c1e-7a00-8000-0000000000b1";
const ORG_SCOPE = { orgId: ORG_ID, workspaceId: ORG_ONLY_WORKSPACE_ID };
const NOW = new Date("2026-09-12T10:00:00.000Z");
const PERMISSION = "org.admin";
const NOT_BACKED = {
  ok: false,
  reason: "not_backed",
  milestone: "M0",
  gap: "G0",
};
const DENIED = { ok: false, reason: "denied", permission: PERMISSION };

const settings: OrgSettingsReadOutput = {
  name: "Acme Robotics",
  slug: "acme",
  avatarUrl: null,
  website: null,
  industry: null,
  employeeSize: null,
  type: "business",
};
const listed: WorkspaceListOutput = {
  organization: {
    id: ORG_ID,
    publicId: "org_4x1c8v5b3n6z0p2r7m2k9q",
    slug: "acme",
    namespace: "acme",
    name: "Acme Robotics",
  },
  workspaces: [
    {
      id: WS_A,
      publicId: "wrk_1c8v5b3n6z0p2r7m2k9q4x",
      slug: "core-platform",
      namespace: "core",
      name: "Core Platform",
      role: "owner",
    },
  ],
};
const credential: OrgModelCredentialGetOutput = {
  configured: true,
  provider: "gateway",
  status: "active",
  keyHint: "9f2c",
  lastVerifiedAt: "2026-09-10T08:00:00.000Z",
  rotatedAt: "2026-09-01T08:00:00.000Z",
};
const plane = (kind: OrgDataPlaneGetOutput["kind"]): OrgDataPlaneGetOutput => ({
  kind,
  mode: "shared",
  status: "active",
  host: null,
  database: null,
  schemaVersion: null,
  lastVerifiedAt: null,
  rotatedAt: null,
});

const store = (): OrgStore => ({
  planTier: vi.fn(async () => "enterprise"),
  members: vi.fn(async () => [
    {
      membership: { role: "Owner", joinedAt: new Date("2026-03-01T09:00:00Z") },
      user: { publicId: "usr_7m2k9q4x1c8v5b3n6z0p2r", twoFactorEnabled: true },
      workspaces: [{ slug: "core-platform", role: "owner" }],
      lastSessionAt: new Date("2026-09-12T08:41:00Z"),
    },
  ]),
  invitations: vi.fn(async () => [
    {
      invitation: {
        email: "priya.nair@acme.test",
        role: "Member",
        createdAt: new Date("2026-09-08T14:30:00Z"),
        expiresAt: new Date("2026-09-15T14:30:00Z"),
      },
      inviterPublicId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
    },
  ]),
  apiKeys: vi.fn(async () => [
    {
      key: {
        name: "ci-deployer",
        keyPrefix: "oxk_live_4f9a",
        lastUsedAt: null,
        expiresAt: null,
      },
      creatorPublicId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
    },
  ]),
  workspaceFacts: vi.fn(
    async () =>
      new Map([
        [WS_A, { agentCount: 4, ownerPublicId: "usr_7m2k9q4x1c8v5b3n6z0p2r" }],
      ]),
  ),
  assistantSpend: vi.fn(async () => ({ capCents: 2000, spentCents: 250n })),
});

/** Answers each agent tool the adapter invokes with a representative output. */
const toolOutputs: Record<string, (input: unknown) => unknown> = {
  get_org_settings: () => settings,
  list_workspaces: () => listed,
  get_model_credential: () => credential,
  get_data_plane: (input) =>
    plane((input as { kind: OrgDataPlaneGetOutput["kind"] }).kind),
};

function fakeInvoke(): OrgInvoke & ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async (call: { contract: { name: string }; input: unknown }) => {
      const answer = toolOutputs[call.contract.name];
      if (!answer) throw new Error(`unexpected tool ${call.contract.name}`);
      return answer(call.input);
    },
  );
  return fn as unknown as OrgInvoke & ReturnType<typeof vi.fn>;
}

function deps(over: Partial<OrgLiveDeps> = {}): OrgLiveDeps {
  return {
    principal: vi.fn(async () => USER_ID),
    orgRole: vi.fn(async () => "admin"),
    invoke: fakeInvoke(),
    store: store(),
    report: vi.fn(),
    now: () => NOW,
    ...over,
  };
}

/** The promote list's contract change: unrecorded fields accepted as null. */
const widened = {
  Organization: Organization.extend({
    displayCurrency: Currency.nullable(),
    billingCurrency: Currency.nullable(),
    deploymentMode: Organization.shape.deploymentMode.nullable(),
    region: z.string().nullable(),
    governanceMode: Organization.shape.governanceMode.nullable(),
    attesterKeyId: z.string().nullable(),
  }),
  Member,
  Invitation,
  Workspace: Workspace.extend({
    mainRepo: z.string().nullable(),
    productionBranch: z.string().nullable(),
    linkedRepos: z.array(z.string()).nullable(),
  }),
  ApiKey: ApiKey.extend({
    principal: z.string().nullable(),
    grants: z.array(z.string()).min(1).nullable(),
    uses30d: Count.nullable(),
    expiresOn: Day.nullable(),
    createdById: PublicId.nullable(),
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

/** The widened schemas stand in for the promoted view models, which today's types cannot name. */
const widenedViews = widened as unknown as OrgViews;

const ALL_METHODS = [
  "organization",
  "members",
  "invitations",
  "workspaces",
  "apiKeys",
  "dataPlanes",
  "modelFunding",
] as const;
const ADMIN_METHODS = [
  "members",
  "invitations",
  "apiKeys",
  "dataPlanes",
  "modelFunding",
] as const;

describe("allows", () => {
  it("lets any member read a member slice", () => {
    for (const role of [
      "owner",
      "admin",
      "member",
      "billing",
      "compliance",
      "viewer",
    ])
      expect(allows("member", role)).toBe(true);
  });

  it("lets only owners and admins, in either casing, read an admin slice", () => {
    expect(allows("admin", "owner")).toBe(true);
    expect(allows("admin", "Admin")).toBe(true);
    for (const role of ["member", "billing", "compliance", "viewer"])
      expect(allows("admin", role)).toBe(false);
  });

  it("refuses a non-member everything", () => {
    expect(allows("member", null)).toBe(false);
    expect(allows("admin", null)).toBe(false);
  });
});

describe("isCapabilityDenial", () => {
  it("recognises the kernel's denial codes", () => {
    for (const code of [
      "authz_denied",
      "pending_approval",
      "surface_denied",
      "capability_not_installed",
    ])
      expect(
        isCapabilityDenial(new mocks.CapabilityError("x", code, "no")),
      ).toBe(true);
  });

  it("does not treat a failing handler or a plain error as a denial", () => {
    expect(
      isCapabilityDenial(
        new mocks.CapabilityError("x", "invalid_output", "bad"),
      ),
    ).toBe(false);
    expect(isCapabilityDenial(new Error("authz_denied"))).toBe(false);
  });
});

describe("createLiveOrg guards", () => {
  it.each(ALL_METHODS)(
    "%s is denied without a session and reads nothing",
    async (method) => {
      const d = deps({ principal: vi.fn(async () => null) });
      await expect(createLiveOrg(d)[method](ORG_SCOPE)).resolves.toEqual(
        DENIED,
      );
      expect(d.orgRole).not.toHaveBeenCalled();
      expect(d.invoke).not.toHaveBeenCalled();
    },
  );

  it.each(ALL_METHODS)("%s is denied to a non-member", async (method) => {
    const d = deps({ orgRole: vi.fn(async () => null) });
    await expect(createLiveOrg(d)[method](ORG_SCOPE)).resolves.toEqual(DENIED);
    expect(d.invoke).not.toHaveBeenCalled();
    expect(d.store.members).not.toHaveBeenCalled();
  });

  it.each(ADMIN_METHODS)("%s is denied to a plain member", async (method) => {
    const d = deps({ orgRole: vi.fn(async () => "member") });
    await expect(createLiveOrg(d)[method](ORG_SCOPE)).resolves.toEqual(DENIED);
    expect(d.invoke).not.toHaveBeenCalled();
  });

  it("asks for the role in the scope's organization, as the signed-in person", async () => {
    const d = deps();
    await createLiveOrg(d).members({ orgId: ORG_ID, workspaceId: WS_A });
    expect(d.orgRole).toHaveBeenCalledWith(ORG_ID, USER_ID);
  });

  it("lets a plain member read the organization and its workspace list", async () => {
    const d = deps({
      orgRole: vi.fn(async () => "viewer"),
      views: widenedViews,
    });
    const port = createLiveOrg(d);
    await expect(port.organization(ORG_SCOPE)).resolves.toMatchObject({
      ok: true,
    });
    await expect(port.workspaces(ORG_SCOPE)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("answers a kernel denial as denied, not as an outage", async () => {
    const d = deps({
      invoke: vi.fn(async () => {
        throw new mocks.CapabilityError(
          "get_data_plane",
          "authz_denied",
          "no grant",
        );
      }) as unknown as OrgInvoke,
    });
    await expect(createLiveOrg(d).dataPlanes(ORG_SCOPE)).resolves.toEqual(
      DENIED,
    );
    expect(d.report).not.toHaveBeenCalled();
  });

  it("reports a failed store and answers the page's named error", async () => {
    const failure = new Error("connection reset");
    const d = deps();
    vi.mocked(d.store.invitations).mockRejectedValueOnce(failure);
    await expect(createLiveOrg(d).invitations(ORG_SCOPE)).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "control_plane_unavailable",
      status: 503,
    });
    expect(d.report).toHaveBeenCalledWith(
      failure,
      "org.invitations read failed",
    );
  });

  it("reports a failed role lookup as the same named error", async () => {
    const d = deps({
      orgRole: vi.fn(async () => {
        throw new Error("pool exhausted");
      }),
    });
    await expect(
      createLiveOrg(d).organization(ORG_SCOPE),
    ).resolves.toMatchObject({
      reason: "error",
      code: "control_plane_unavailable",
    });
  });
});

describe("createLiveOrg reads", () => {
  it("wires members through the Member view model", async () => {
    await expect(createLiveOrg(deps()).members(ORG_SCOPE)).resolves.toEqual({
      ok: true,
      value: [
        {
          personId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
          role: "owner",
          workspaces: [{ slug: "core-platform", role: "owner" }],
          allWorkspaces: false,
          status: "active",
          lastActiveAt: "2026-09-12T08:41:00.000Z",
          mfa: ["totp"],
          sso: null,
        },
      ],
    });
  });

  it("wires invitations, reading pending ones as of now", async () => {
    const d = deps();
    await expect(createLiveOrg(d).invitations(ORG_SCOPE)).resolves.toEqual({
      ok: true,
      value: [
        {
          email: "priya.nair@acme.test",
          role: { scope: "org", role: "member" },
          invitedById: "usr_7m2k9q4x1c8v5b3n6z0p2r",
          sentOn: "2026-09-08",
          expiresOn: "2026-09-15",
        },
      ],
    });
    expect(d.store.invitations).toHaveBeenCalledWith(ORG_ID, NOW);
  });

  it("answers an empty roster as an empty value, not as not recorded", async () => {
    const d = deps();
    vi.mocked(d.store.invitations).mockResolvedValueOnce([]);
    await expect(createLiveOrg(d).invitations(ORG_SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
  });

  it.each([
    "organization",
    "workspaces",
    "apiKeys",
    "dataPlanes",
    "modelFunding",
  ] as const)(
    "%s settles as not recorded against today's view model, as backing.ts says",
    async (method) => {
      await expect(createLiveOrg(deps())[method](ORG_SCOPE)).resolves.toEqual({
        ...NOT_BACKED,
        milestone: BACKING.org[method].milestone,
        gap: BACKING.org[method].gap,
      });
    },
  );

  it("reports a value the view model rejects as a mapping defect", async () => {
    const d = deps();
    vi.mocked(d.store.members).mockResolvedValueOnce([
      {
        membership: { role: "owner", joinedAt: NOW },
        user: { publicId: "not a public id", twoFactorEnabled: false },
        workspaces: [],
        lastSessionAt: null,
      },
    ]);
    await expect(createLiveOrg(d).members(ORG_SCOPE)).resolves.toEqual({
      ok: false,
      reason: "error",
      code: ORG_RECORD_UNMAPPABLE,
      status: 500,
    });
    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("personId") }),
      "org.members unmappable",
    );
  });

  it("reads the organization through get_org_settings and the plan tier", async () => {
    const d = deps({ views: widenedViews });
    await expect(
      createLiveOrg(d).organization({ orgId: ORG_ID, workspaceId: WS_A }),
    ).resolves.toEqual({
      ok: true,
      value: {
        slug: "acme",
        name: "Acme Robotics",
        plan: "enterprise",
        displayCurrency: null,
        billingCurrency: null,
        deploymentMode: null,
        region: null,
        governanceMode: null,
        attesterKeyId: null,
      },
    });
    // An organization read runs under the organization-only sentinel.
    expect(d.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: ORG_SCOPE,
        userId: USER_ID,
        contract: expect.objectContaining({ name: "get_org_settings" }),
        input: {},
      }),
    );
    expect(d.store.planTier).toHaveBeenCalledWith(ORG_ID);
  });

  it("lists workspaces through list_workspaces by the organization's slug", async () => {
    const d = deps({ views: widenedViews });
    await expect(createLiveOrg(d).workspaces(ORG_SCOPE)).resolves.toEqual({
      ok: true,
      value: [
        {
          slug: "core-platform",
          name: "Core Platform",
          mainRepo: null,
          productionBranch: null,
          linkedRepos: null,
          agentCount: 4,
          ownerId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
        },
      ],
    });
    expect(d.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: expect.objectContaining({ name: "list_workspaces" }),
        input: { orgSlug: "acme" },
      }),
    );
    expect(d.store.workspaceFacts).toHaveBeenCalledWith(ORG_ID, [WS_A]);
  });

  it("never shows zero agents for a workspace its scoped reads missed", async () => {
    const d = deps({ views: widenedViews });
    vi.mocked(d.store.workspaceFacts).mockResolvedValueOnce(new Map());
    await expect(createLiveOrg(d).workspaces(ORG_SCOPE)).resolves.toEqual(
      NOT_BACKED,
    );
  });

  it("reads API keys with a derived status and the stored prefix only", async () => {
    const d = deps({ views: widenedViews });
    await expect(createLiveOrg(d).apiKeys(ORG_SCOPE)).resolves.toEqual({
      ok: true,
      value: [
        {
          name: "ci-deployer",
          maskedKey: "oxk_live_4f9a…",
          principal: null,
          grants: null,
          createdById: "usr_7m2k9q4x1c8v5b3n6z0p2r",
          lastUsedAt: null,
          uses30d: null,
          expiresOn: null,
          status: "unused",
        },
      ],
    });
  });

  it("reads one binding per store kind through get_data_plane", async () => {
    const d = deps({ views: widenedViews });
    const res = await createLiveOrg(d).dataPlanes(ORG_SCOPE);
    expect(res).toMatchObject({
      ok: true,
      value: [{ store: "postgres" }, { store: "neo4j" }, { store: null }],
    });
    expect(
      vi
        .mocked(d.invoke)
        .mock.calls.map((c) => (c[0] as { input: unknown }).input),
    ).toEqual([
      { kind: "postgres" },
      { kind: "neo4j" },
      { kind: "clickhouse" },
    ]);
  });

  it("reads funding from the stored credential and the credit ledger", async () => {
    const d = deps({ views: widenedViews });
    await expect(createLiveOrg(d).modelFunding(ORG_SCOPE)).resolves.toEqual({
      ok: true,
      value: {
        source: "customer_key",
        monthlyCap: { micros: "20000000", currency: "USD" },
        usedThisMonth: { micros: "2500000", currency: "USD" },
        routes: null,
      },
    });
    expect(d.store.assistantSpend).toHaveBeenCalledWith(ORG_ID);
  });
});

describe("kernelOrgInvoke", () => {
  const contract = {
    name: "get_org_settings",
    input: {
      _input: {},
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
    },
    output: {
      _output: settings,
      safeParse: (v: unknown) =>
        (v as { name?: unknown }).name === "Acme Robotics"
          ? { success: true as const, data: v as OrgSettingsReadOutput }
          : {
              success: false as const,
              error: { issues: [{ path: ["name"] }] },
            },
    },
  } satisfies ToolContract<Record<string, never>, OrgSettingsReadOutput>;

  beforeEach(() => {
    mocks.getCapability.mockReturnValue({ name: "get_org_settings" });
  });

  it("loads handlers, invokes as the person in the tenant scope, and parses the output", async () => {
    let seen: unknown = null;
    mocks.invoke.mockImplementationOnce(async () => {
      seen = getScope();
      return settings;
    });
    await expect(
      kernelOrgInvoke({
        scope: ORG_SCOPE,
        userId: USER_ID,
        contract,
        input: {},
      }),
    ).resolves.toEqual(settings);
    expect(mocks.registry.loaded).toBe(1);
    expect(seen).toMatchObject(ORG_SCOPE);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_org_settings",
      {},
      expect.objectContaining({
        orgId: ORG_ID,
        workspaceId: ORG_ONLY_WORKSPACE_ID,
        userId: USER_ID,
        apiKeyId: null,
        surface: "app",
      }),
    );
  });

  it("refuses a tool the registry does not know", async () => {
    mocks.getCapability.mockReturnValueOnce(undefined);
    await expect(
      kernelOrgInvoke({
        scope: ORG_SCOPE,
        userId: USER_ID,
        contract,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ToolNotRegistered);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("throws rather than pass on an output the contract rejects", async () => {
    mocks.invoke.mockResolvedValueOnce({ name: 42 });
    await expect(
      kernelOrgInvoke({
        scope: ORG_SCOPE,
        userId: USER_ID,
        contract,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ContractOutputMismatch);
  });
});

describe("production deps", () => {
  it("takes the principal from the session, and null without one", async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: USER_ID } });
    await expect(liveOrgDeps.principal()).resolves.toBe(USER_ID);
    mocks.getSession.mockResolvedValueOnce(null);
    await expect(liveOrgDeps.principal()).resolves.toBeNull();
  });

  it("asks the tenancy lookups for the organization role", async () => {
    mocks.orgRole.mockResolvedValueOnce("owner");
    await expect(liveOrgDeps.orgRole(ORG_ID, USER_ID)).resolves.toBe("owner");
    expect(mocks.orgRole).toHaveBeenCalledWith(ORG_ID, USER_ID);
  });

  it("reports through telemetry and never throws from a report", async () => {
    liveOrgDeps.report(new Error("boom"), "org.members read failed");
    await vi.waitFor(() =>
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "app",
          context: "org.members read failed",
        }),
      ),
    );
    mocks.captureError.mockImplementationOnce(() => {
      throw new Error("clickhouse down");
    });
    await expect(
      reportToTelemetry(new Error("x"), "ctx"),
    ).resolves.toBeUndefined();
    expect(liveOrgDeps.now()).toBeInstanceOf(Date);
  });

  it("builds the exported port from the production deps", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    await expect(liveOrg.members(ORG_SCOPE)).resolves.toEqual(DENIED);
  });
});

// ---- The store, against a recording fake transaction ---------------------------

type Recorded = {
  table: string;
  columns: string[];
  scope: { orgId: string; workspaceId: string } | null;
};

function tableName(table: unknown): string {
  return getTableName(table as Table);
}

/** A drizzle-shaped select chain that answers from `rows` by table name. */
function fakeTx(rows: (q: Recorded) => unknown[], log: Recorded[]) {
  return {
    select(selection: Record<string, unknown> = {}) {
      const q: Recorded = {
        table: "",
        columns: Object.keys(selection),
        scope: getScope() as Recorded["scope"],
      };
      const chain = {
        from(table: unknown) {
          q.table = tableName(table);
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        groupBy: () => chain,
        then<R>(ok: (v: unknown[]) => R, fail?: (e: unknown) => R) {
          log.push(q);
          return Promise.resolve()
            .then(() => rows(q))
            .then(ok, fail);
        },
      };
      return chain;
    },
  };
}

describe("postgresOrgStore", () => {
  let log: Recorded[];
  const answers = new Map<string, (q: Recorded) => unknown[]>();

  beforeEach(() => {
    log = [];
    answers.clear();
    mocks.withTenantDb.mockImplementation(async (fn) =>
      fn(fakeTx((q) => answers.get(q.table)?.(q) ?? [], log)),
    );
  });
  afterEach(() => {
    mocks.withTenantDb.mockReset();
  });

  const t = tableName;

  it("reads members org-wide and their workspace roles in each workspace's own scope", async () => {
    const lastSeen = new Date("2026-09-12T08:41:00Z");
    answers.set(t(schema.orgUsers), () => [
      {
        userId: USER_ID,
        role: "Owner",
        joinedAt: NOW,
        publicId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
        twoFactorEnabled: true,
      },
      {
        userId: "0192d4a8-7c1e-7a00-8000-0000000000b2",
        role: "viewer",
        joinedAt: NOW,
        publicId: "usr_2k9q4x1c8v5b3n6z0p2r7m",
        twoFactorEnabled: false,
      },
    ]);
    answers.set(t(schema.sessions), () => [{ userId: USER_ID, at: lastSeen }]);
    answers.set(t(schema.workspaces), () => [{ id: WS_A }, { id: WS_B }]);
    answers.set(t(schema.workspaceUsers), (q) =>
      q.scope?.workspaceId === WS_A
        ? [
            {
              userId: USER_ID,
              role: "owner",
              slug: "core-platform",
              publicId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
            },
          ]
        : [
            {
              userId: USER_ID,
              role: "Viewer",
              slug: "zeta-lab",
              publicId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
            },
          ],
    );

    const members = await postgresOrgStore.members(ORG_ID);

    expect(members).toEqual([
      {
        membership: { role: "Owner", joinedAt: NOW },
        user: {
          publicId: "usr_7m2k9q4x1c8v5b3n6z0p2r",
          twoFactorEnabled: true,
        },
        workspaces: [
          { slug: "core-platform", role: "owner" },
          { slug: "zeta-lab", role: "Viewer" },
        ],
        lastSessionAt: lastSeen,
      },
      {
        membership: { role: "viewer", joinedAt: NOW },
        user: {
          publicId: "usr_2k9q4x1c8v5b3n6z0p2r7m",
          twoFactorEnabled: false,
        },
        workspaces: [],
        lastSessionAt: null,
      },
    ]);
    const scopeOf = (table: string) =>
      log.filter((q) => q.table === table).map((q) => q.scope?.workspaceId);
    expect(scopeOf(t(schema.orgUsers))).toEqual([ORG_ONLY_WORKSPACE_ID]);
    expect(scopeOf(t(schema.workspaceUsers)).sort()).toEqual([WS_A, WS_B]);
    expect(log.every((q) => q.scope?.orgId === ORG_ID)).toBe(true);
  });

  it("skips the session read for an organization with no members", async () => {
    answers.set(t(schema.workspaces), () => []);
    await expect(postgresOrgStore.members(ORG_ID)).resolves.toEqual([]);
    expect(log.map((q) => q.table)).not.toContain(t(schema.sessions));
  });

  it("reads pending invitations with their inviter", async () => {
    answers.set(t(schema.invitations), () => [
      {
        email: "priya.nair@acme.test",
        role: "Member",
        createdAt: NOW,
        expiresAt: null,
        inviterPublicId: null,
      },
    ]);
    await expect(postgresOrgStore.invitations(ORG_ID, NOW)).resolves.toEqual([
      {
        invitation: {
          email: "priya.nair@acme.test",
          role: "Member",
          createdAt: NOW,
          expiresAt: null,
        },
        inviterPublicId: null,
      },
    ]);
    expect(log[0]?.scope).toMatchObject(ORG_SCOPE);
  });

  it("reads API keys in each workspace's scope and never selects the hash", async () => {
    answers.set(t(schema.workspaces), () => [{ id: WS_A }, { id: WS_B }]);
    answers.set(t(schema.apiKeys), (q) => [
      {
        name: `key-${q.scope?.workspaceId === WS_A ? "a" : "b"}`,
        keyPrefix: "oxk_live_4f9a",
        lastUsedAt: null,
        expiresAt: null,
        creatorPublicId: null,
      },
    ]);
    const keys = await postgresOrgStore.apiKeys(ORG_ID);
    expect(keys.map((k) => k.key.name).sort()).toEqual(["key-a", "key-b"]);
    const keyQueries = log.filter((q) => q.table === t(schema.apiKeys));
    expect(keyQueries.map((q) => q.scope?.workspaceId).sort()).toEqual([
      WS_A,
      WS_B,
    ]);
    for (const q of keyQueries) expect(q.columns).not.toContain("keyHash");
  });

  it("counts agents and finds the earliest owner in each workspace's scope", async () => {
    answers.set(t(schema.principals), (q) => [
      { n: q.scope?.workspaceId === WS_A ? 3 : 0 },
    ]);
    answers.set(t(schema.workspaceUsers), (q) =>
      q.scope?.workspaceId === WS_A
        ? [
            { userId: "u2", role: "member", slug: "a", publicId: "usr_member" },
            { userId: "u1", role: "Owner", slug: "a", publicId: "usr_owner" },
          ]
        : [],
    );
    const facts = await postgresOrgStore.workspaceFacts(ORG_ID, [WS_A, WS_B]);
    expect(facts.get(WS_A)).toEqual({
      agentCount: 3,
      ownerPublicId: "usr_owner",
    });
    expect(facts.get(WS_B)).toEqual({ agentCount: 0, ownerPublicId: null });
  });

  it("leaves the agent count unread when the count query returns no row", async () => {
    const facts = await postgresOrgStore.workspaceFacts(ORG_ID, [WS_A]);
    expect(facts.get(WS_A)).toEqual({ agentCount: null, ownerPublicId: null });
  });

  it("resolves the plan tier and the assistant spend inside the organization scope", async () => {
    let tierScope: unknown = null;
    mocks.resolveOrgTier.mockImplementationOnce(async () => {
      tierScope = getScope();
      return "scale";
    });
    await expect(postgresOrgStore.planTier(ORG_ID)).resolves.toBe("scale");
    expect(tierScope).toMatchObject(ORG_SCOPE);

    mocks.getOrgBillingSettings.mockResolvedValueOnce({
      assistantSpendCapCents: null,
    });
    mocks.assistantSpendThisMonth.mockResolvedValueOnce(99n);
    await expect(postgresOrgStore.assistantSpend(ORG_ID)).resolves.toEqual({
      capCents: null,
      spentCents: 99n,
    });
    expect(mocks.getOrgBillingSettings).toHaveBeenCalledWith(ORG_ID);
  });
});
