import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import { canonicalJson, sha256Hex } from "./registry-digest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// Publishing locks the workspace and reads/writes tool versions in one transaction.
// The select queue holds the existing tool and latest version, when present;
// the workspace lock has its own result so it cannot consume either fixture.
// A publish that changes the safety classification reads the workspace's
// consequence roles (query.workspaces.findFirst) before it writes.
//
// Roles (INV-29) are a double of assertOrgRole: the caller's org and
// workspace role come from `mocks.roles`, and the double refuses a role
// outside the sets the handler asks for, so each test asserts WHICH roles
// the handler asks for.
//   - a Member (org and workspace) → forbidden, nothing read or written
//   - an org Admin publishes a declaration with no consequence
//   - changing the classification of a moves_money tool: an org Admin (with
//     workspace Admin) is refused before any version is written; an org
//     Owner, and an org Billing user with workspace Admin, publish
//   - a new tool declaring moves_money needs the moves_money office
//   - an unchanged classification asks no consequence role
//   - a classification on a name no capability is registered under is
//     refused conflict / consequence_not_gated before anything is read; the
//     same name with no classification publishes
// Tool/version selects share one queue; workspace locking has its own fixture.
// The transaction call gets a builder whose
// inserts/updates resolve via dedicated spies so ordering and shapes can be
// asserted (same seam as skill.workspace.install.test.ts).
const mocks = vi.hoisted(() => ({
  selectResults: [] as Array<() => Promise<unknown>>,
  workspaceExists: true,
  workspaceLocks: [] as string[],
  insertReturning: [] as Array<() => Promise<unknown>>,
  insertedValues: [] as Array<Record<string, unknown>>,
  updateSets: [] as Array<Record<string, unknown>>,
  updateReturning: [] as Array<unknown[]>,
  roles: { org: "Owner", workspace: null } as {
    org: string | null;
    workspace: string | null;
  },
  consequenceRoles: {} as Record<string, string[]>,
  capabilities: new Set<string>(["read_file"]),
}));

vi.mock("@oxagen/oxagen", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen")>();
  return {
    ...real,
    getCapability: (name: string) =>
      mocks.capabilities.has(name) ? { name } : undefined,
  };
});

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId: string | null }) => ctx.userId,
  assertOrgRole: async (
    _ctx: unknown,
    required: { org: readonly string[]; workspace?: readonly string[] },
  ) => {
    const { org, workspace } = mocks.roles;
    if (org && required.org.includes(org)) return org;
    if (workspace && required.workspace?.includes(workspace)) return workspace;
    throw new HandlerError({ code: "forbidden", reason: "org_role_required" });
  },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const makeTx = () => ({
    query: {
      workspaces: {
        findFirst: async () => ({
          consequenceRoles: mocks.consequenceRoles,
          settings: {}, // No approval rules in this declaration/role-gate fixture.
        }),
      },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          for: async (mode: string) => {
            if (table !== real.schema.workspaces)
              throw new Error("Unexpected locked table in declaration fixture");
            mocks.workspaceLocks.push(mode);
            return mocks.workspaceExists ? [{ id: "ws_1" }] : [];
          },
          limit: () => {
            const next = mocks.selectResults.shift();
            return next ? next() : Promise.resolve([]);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (vals: unknown) => {
        mocks.insertedValues.push(vals as Record<string, unknown>);
        const next = mocks.insertReturning.shift();
        return {
          returning: () =>
            next ? next() : Promise.resolve([{ id: "uuid-generated" }]),
        };
      },
    }),
    update: () => ({
      set: (vals: unknown) => {
        mocks.updateSets.push(vals as Record<string, unknown>);
        return {
          where: () =>
            Object.assign(Promise.resolve(), {
              returning: () =>
                Promise.resolve(mocks.updateReturning.shift() ?? []),
            }),
        };
      },
    }),
  });

  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { toolDeclarationPublishHandler } from "./tool.declaration.publish";

// ── fixtures ──────────────────────────────────────────────────────────────────
const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const INPUT = {
  name: "Read_File",
  description: "Read a file from the workspace",
  input_schema: { type: "object" },
  read_only: true,
  risk_grade: "low" as const,
  policy_group: undefined,
  source: "builtin" as const,
  manifest: { name: "read_file" },
  consequence_tags: [] as string[],
  measures: {},
  effect_id_path: undefined,
};

const EXPECTED_CHECKSUM = sha256Hex(
  canonicalJson({
    consequence_tags: [],
    description: INPUT.description,
    effect_id_path: null,
    input_schema: INPUT.input_schema,
    manifest: INPUT.manifest,
    measures: {},
    name: "read_file",
    policy_group: null,
    read_only: true,
    risk_grade: "low",
    source: "builtin",
  }),
);

function queueSelects(...results: unknown[]): void {
  for (const r of results) {
    mocks.selectResults.push(() => Promise.resolve(r));
  }
}

const forbidden = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "forbidden" && e.reason === reason;
const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;

beforeEach(() => {
  mocks.roles = { org: "Owner", workspace: null };
  mocks.consequenceRoles = {};
  mocks.selectResults.length = 0;
  mocks.workspaceExists = true;
  mocks.workspaceLocks.length = 0;
  mocks.insertReturning.length = 0;
  mocks.insertedValues.length = 0;
  mocks.updateSets.length = 0;
  mocks.updateReturning.length = 0;
});

describe("tool.declaration.publish handler", () => {
  it("registers a fresh declaration as version 1 with the canonical checksum", async () => {
    queueSelects([]); // no existing tool
    mocks.insertReturning.push(
      () =>
        Promise.resolve([
          { id: "tool-uuid", publicId: "tol_new", slug: "read_file" },
        ]),
      () => Promise.resolve([{ id: "version-uuid" }]),
    );

    const out = await toolDeclarationPublishHandler(INPUT, CTX);

    expect(out).toEqual({
      publicId: "tol_new",
      slug: "read_file",
      version: 1,
      checksum: EXPECTED_CHECKSUM,
      published: true,
    });
    expect(mocks.workspaceLocks).toEqual(["update"]);
    expect(mocks.selectResults).toHaveLength(0);
    // The name is lowercased into the slug; the version row carries the facts.
    expect(mocks.insertedValues[0]).toMatchObject({ slug: "read_file" });
    expect(mocks.insertedValues[1]).toMatchObject({
      toolId: "tool-uuid",
      versionNumber: 1,
      isLatest: true,
      readOnly: true,
      riskGrade: "low",
      checksum: EXPECTED_CHECKSUM,
    });
    // The identity row is backfilled with the pinned active version.
    expect(mocks.updateSets.at(-1)).toMatchObject({
      activeVersionId: "version-uuid",
    });
  });

  it("is idempotent when the latest version already carries the checksum", async () => {
    queueSelects(
      [{ id: "tool-uuid", publicId: "tol_1", slug: "read_file" }],
      [{ id: "v1-uuid", versionNumber: 3, checksum: EXPECTED_CHECKSUM }],
    );

    const out = await toolDeclarationPublishHandler(INPUT, CTX);

    expect(out).toEqual({
      publicId: "tol_1",
      slug: "read_file",
      version: 3,
      checksum: EXPECTED_CHECKSUM,
      published: false,
    });
    expect(mocks.insertedValues).toHaveLength(0);
    expect(mocks.updateSets).toHaveLength(0);
  });

  it("publishes latest+1 and demotes the previous latest when the checksum changed", async () => {
    queueSelects(
      [{ id: "tool-uuid", publicId: "tol_1", slug: "read_file" }],
      [
        {
          id: "v2-uuid",
          versionNumber: 2,
          checksum: "0".repeat(64),
          consequenceTags: [],
          measures: {},
          effectIdPath: null,
        },
      ],
    );
    mocks.insertReturning.push(() => Promise.resolve([{ id: "v3-uuid" }]));

    const out = await toolDeclarationPublishHandler(INPUT, CTX);

    expect(out.version).toBe(3);
    expect(out.published).toBe(true);
    // First update demotes the previous latest, then the version insert, then
    // the identity-row repoint.
    expect(mocks.updateSets[0]).toMatchObject({ isLatest: false });
    expect(mocks.insertedValues[0]).toMatchObject({
      versionNumber: 3,
      parentVersionId: "v2-uuid",
      checksum: EXPECTED_CHECKSUM,
    });
    expect(mocks.updateSets[1]).toMatchObject({ activeVersionId: "v3-uuid" });
  });

  it("refuses publication when the workspace lock finds no row", async () => {
    mocks.workspaceExists = false;
    queueSelects([]);
    await expect(
      toolDeclarationPublishHandler(INPUT, CTX),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_not_found",
    });
    expect(mocks.workspaceLocks).toEqual(["update"]);
    expect(mocks.selectResults).toHaveLength(1); // No tool lookup after refusal.
    expect(mocks.insertedValues).toEqual([]);
    expect(mocks.updateSets).toEqual([]);
  });

  it("requires a workspace scope", async () => {
    await expect(
      toolDeclarationPublishHandler(INPUT, {
        ...CTX,
        workspaceId: undefined as unknown as string,
      }),
    ).rejects.toThrow(/workspaceId is required/);
  });
});

describe("tool.declaration.publish roles", () => {
  const TOOL = { id: "tool-uuid", publicId: "tol_1", slug: "read_file" };
  const MONEY = {
    consequenceTags: ["moves_money"],
    measures: {
      amount: { path: "amount", type: "amount", unit: "USD", scale: 2 },
    },
    effectIdPath: "id",
  };
  const MONEY_INPUT = {
    ...INPUT,
    consequence_tags: MONEY.consequenceTags,
    measures: MONEY.measures as typeof INPUT.measures,
    effect_id_path: MONEY.effectIdPath,
  };
  const latestV2 = (classification: object) => ({
    id: "v2-uuid",
    versionNumber: 2,
    checksum: "0".repeat(64),
    ...classification,
  });

  it("refuses a Member before anything is read or written", async () => {
    mocks.roles = { org: "Member", workspace: "Member" };
    await expect(toolDeclarationPublishHandler(INPUT, CTX)).rejects.toSatisfy(
      forbidden("org_role_required"),
    );
    expect(mocks.selectResults).toHaveLength(0);
    expect(mocks.insertedValues).toHaveLength(0);
    expect(mocks.updateSets).toHaveLength(0);
  });

  it("lets an org Admin publish a declaration that carries no consequence", async () => {
    mocks.roles = { org: "Admin", workspace: null };
    queueSelects([]);
    mocks.insertReturning.push(
      () => Promise.resolve([TOOL]),
      () => Promise.resolve([{ id: "version-uuid" }]),
    );
    await expect(
      toolDeclarationPublishHandler(INPUT, CTX),
    ).resolves.toMatchObject({ published: true, version: 1 });
  });

  it("refuses an Admin who drops moves_money from a tool: no version row is written", async () => {
    mocks.roles = { org: "Admin", workspace: "Admin" };
    queueSelects([TOOL], [latestV2(MONEY)]);
    await expect(toolDeclarationPublishHandler(INPUT, CTX)).rejects.toSatisfy(
      forbidden("org_role_required"),
    );
    expect(mocks.insertedValues).toHaveLength(0);
    expect(mocks.updateSets).toHaveLength(0);
  });

  it("refuses an Admin who re-measures a moves_money tool", async () => {
    mocks.roles = { org: "Admin", workspace: null };
    queueSelects(
      [TOOL],
      [
        latestV2({
          ...MONEY,
          measures: {
            amount: { path: "amount", type: "amount", unit: "USD", scale: 6 },
          },
        }),
      ],
    );
    await expect(
      toolDeclarationPublishHandler(MONEY_INPUT, CTX),
    ).rejects.toSatisfy(forbidden("org_role_required"));
    expect(mocks.insertedValues).toHaveLength(0);
  });

  it.each([
    ["an org Owner", { org: "Owner", workspace: null }],
    [
      "an org Billing user with workspace Admin",
      { org: "Billing", workspace: "Admin" },
    ],
  ])("lets %s drop moves_money", async (_label, roles) => {
    mocks.roles = roles;
    queueSelects([TOOL], [latestV2(MONEY)]);
    mocks.insertReturning.push(() => Promise.resolve([{ id: "v3-uuid" }]));
    await expect(
      toolDeclarationPublishHandler(INPUT, CTX),
    ).resolves.toMatchObject({ published: true, version: 3 });
    expect(mocks.insertedValues[0]).toMatchObject({ consequenceTags: [] });
  });

  it("asks the workspace's override for the office", async () => {
    mocks.roles = { org: "Admin", workspace: null };
    mocks.consequenceRoles = { moves_money: ["Admin"] };
    queueSelects([TOOL], [latestV2(MONEY)]);
    mocks.insertReturning.push(() => Promise.resolve([{ id: "v3-uuid" }]));
    await expect(
      toolDeclarationPublishHandler(INPUT, CTX),
    ).resolves.toMatchObject({ published: true });
  });

  it("a new tool declaring moves_money needs the moves_money office", async () => {
    mocks.roles = { org: "Admin", workspace: null };
    queueSelects([]);
    await expect(
      toolDeclarationPublishHandler(MONEY_INPUT, CTX),
    ).rejects.toSatisfy(forbidden("org_role_required"));
    expect(mocks.insertedValues).toHaveLength(0);
  });

  it("an unchanged classification asks no consequence role", async () => {
    mocks.roles = { org: "Admin", workspace: null };
    queueSelects([TOOL], [latestV2(MONEY)]);
    mocks.insertReturning.push(() => Promise.resolve([{ id: "v3-uuid" }]));
    await expect(
      toolDeclarationPublishHandler(
        { ...MONEY_INPUT, description: "Pay an invoice, reworded" },
        CTX,
      ),
    ).resolves.toMatchObject({ published: true, version: 3 });
  });

  it.each([
    ["consequence_tags", { consequence_tags: ["moves_money"] }],
    ["measures", { measures: MONEY.measures as typeof INPUT.measures }],
    ["effect_id_path", { effect_id_path: "id" }],
  ])(
    "refuses %s on a name no capability is registered under",
    async (_field, classification) => {
      const external = {
        ...INPUT,
        name: "stripe__create_payment",
        source: "mcp" as const,
        ...classification,
      };
      await expect(
        toolDeclarationPublishHandler(external, CTX),
      ).rejects.toSatisfy(conflict("consequence_not_gated"));
      expect(mocks.selectResults).toHaveLength(0);
      expect(mocks.insertedValues).toHaveLength(0);
      expect(mocks.updateSets).toHaveLength(0);
    },
  );

  it("publishes a name no capability is registered under when it carries no classification", async () => {
    queueSelects([]);
    mocks.insertReturning.push(
      () => Promise.resolve([{ ...TOOL, slug: "stripe__create_payment" }]),
      () => Promise.resolve([{ id: "version-uuid" }]),
    );
    await expect(
      toolDeclarationPublishHandler(
        { ...INPUT, name: "stripe__create_payment", source: "mcp" },
        CTX,
      ),
    ).resolves.toMatchObject({ published: true, version: 1 });
  });
});
