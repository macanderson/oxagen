import { describe, expect, it, vi, beforeEach } from "vitest";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  orgFindFirst: vi.fn(),
  txInsertOrg: vi.fn(),
  txInsertOrgReturning: vi.fn(),
  txInsertOrgUsers: vi.fn(),
  // withSystemDbFn tracks each withSystemDb call so tests can assert the org
  // creation wraps its writes in the system-bypass transaction.
  withSystemDbFn: vi.fn(),
  bootstrapOrgIAM: vi.fn(),
  bootstrapWorkspace: vi.fn(),
}));

const ORG_ROW = {
  publicId: "org_pub_1",
  name: "Acme Corp",
  slug: "acme",
  type: "business",
  createdAt: new Date("2026-05-01T00:00:00Z"),
  id: "internal_org_id",
};

const WORKSPACE_ROW = {
  id: "internal_ws_id",
  publicId: "ws_pub_1",
  name: "Core",
  slug: "core",
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

// Stub the INSERT chain: insert().values().returning()
const orgValuesStub = { returning: mocks.txInsertOrgReturning };
mocks.txInsertOrg.mockReturnValue({ values: () => orgValuesStub });
// Stub orgUsers insert: insert().values() (no returning)
mocks.txInsertOrgUsers.mockReturnValue({
  values: vi.fn(async () => undefined),
});

/** A fake system transaction: the slug pre-check reads, the main body writes. */
function makeTx(): Record<string, unknown> {
  let insertCount = 0;
  return {
    query: {
      organizations: { findFirst: mocks.orgFindFirst },
    },
    // Namespace derivation reads existing org namespaces before the insert;
    // an empty set means the slug-derived namespace is used verbatim.
    select: () => ({ from: async () => [] }),
    insert: (table: unknown): unknown => {
      insertCount++;
      if (insertCount === 1) return mocks.txInsertOrg(table) as unknown;
      return mocks.txInsertOrgUsers(table) as unknown;
    },
  };
}

function passthrough(): void {
  mocks.withSystemDbFn.mockImplementation(
    async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
      fn(makeTx()),
  );
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ): Promise<unknown> => mocks.withSystemDbFn(fn) as Promise<unknown>,
  };
});

// create_org writes nothing billing-shaped, so the handler has no reason to
// load the billing package. A factory that throws turns an import into a
// failing test rather than a silent dependency.
vi.mock("@oxagen/billing", () => {
  throw new Error("create_org must not load @oxagen/billing");
});

// IAM provisioning is tested in iam-provision.test.ts and the workspace
// bootstrap in workspace-bootstrap.test.ts; here we verify both are called on
// the org transaction with the right arguments.
mocks.bootstrapOrgIAM.mockResolvedValue(undefined);
vi.mock("./iam-provision", () => ({
  bootstrapOrgIAM: mocks.bootstrapOrgIAM,
}));
mocks.bootstrapWorkspace.mockResolvedValue(WORKSPACE_ROW);
vi.mock("./workspace-bootstrap", () => ({
  bootstrapWorkspace: mocks.bootstrapWorkspace,
}));

import { organizationCreateHandler } from "./org.create";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const INPUT = organizationCreate.input.parse({
  name: "Acme Corp",
  slug: "acme",
  workspace: { name: "Core", slug: "core" },
});

describe("organizationCreateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.orgFindFirst.mockClear();
    mocks.txInsertOrg.mockClear();
    mocks.txInsertOrgReturning.mockClear();
    mocks.txInsertOrgUsers.mockClear();
    mocks.bootstrapOrgIAM.mockClear();
    mocks.bootstrapWorkspace.mockClear();
    // Restore defaults
    mocks.orgFindFirst.mockResolvedValue(null);
    mocks.txInsertOrgReturning.mockResolvedValue([ORG_ROW]);
    mocks.bootstrapOrgIAM.mockResolvedValue(undefined);
    mocks.bootstrapWorkspace.mockResolvedValue(WORKSPACE_ROW);
    mocks.withSystemDbFn.mockReset();
    passthrough();
  });

  // ── auth guard ───────────────────────────────────────────────────────────

  it("throws when userId is null (unauthenticated request)", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(organizationCreateHandler(INPUT, anonCtx)).rejects.toThrow(
      "organization.create requires an authenticated user",
    );
    expect(mocks.withSystemDbFn).not.toHaveBeenCalled();
  });

  // ── slug conflict guard ──────────────────────────────────────────────────

  it("refuses a taken slug as a conflict (pre-check path)", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce({ id: "existing_id" });

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slug_taken",
      message: 'slug "acme" already in use',
    });
    expect(mocks.txInsertOrg).not.toHaveBeenCalled();
  });

  it("refuses a slug taken by a concurrent create as a conflict (race condition path)", async () => {
    // Pre-check passes (no row), but the second withSystemDb call (main body)
    // races and hits the unique index.
    let callIdx = 0;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) return fn(makeTx());
        throw Object.assign(new Error("dup"), {
          code: "23505",
          constraint_name: "organizations_slug_idx",
        });
      },
    );

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slug_taken",
    });
  });

  it("re-throws a unique violation on another index unchanged", async () => {
    let callIdx = 0;
    const namespaceRace = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "organizations_namespace_idx",
    });
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) return fn(makeTx());
        throw namespaceRace;
      },
    );

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toBe(
      namespaceRace,
    );
  });

  it("re-throws non-slug database errors unchanged", async () => {
    let callIdx = 0;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) return fn(makeTx());
        throw new Error("connection refused");
      },
    );

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toThrow(
      "connection refused",
    );
  });

  it("throws when the organization insert returns no row", async () => {
    mocks.txInsertOrgReturning.mockResolvedValueOnce([]);

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toThrow(
      "organization insert returned no row",
    );
    expect(mocks.bootstrapOrgIAM).not.toHaveBeenCalled();
    expect(mocks.bootstrapWorkspace).not.toHaveBeenCalled();
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it("returns the new org and its first workspace", async () => {
    const result = await organizationCreateHandler(INPUT, CTX);

    expect(result).toEqual({
      publicId: "org_pub_1",
      name: "Acme Corp",
      slug: "acme",
      type: "business",
      createdAt: "2026-05-01T00:00:00.000Z",
      workspace: { publicId: "ws_pub_1", slug: "core" },
    });
  });

  it("writes the org, the owner membership, IAM and the first workspace on one system transaction", async () => {
    await organizationCreateHandler(INPUT, CTX);

    // withSystemDb is called twice: (1) the slug pre-check, (2) the bootstrap.
    expect(mocks.withSystemDbFn).toHaveBeenCalledTimes(2);
    expect(mocks.txInsertOrg).toHaveBeenCalledTimes(1);
    expect(mocks.txInsertOrgUsers).toHaveBeenCalledTimes(1);

    const iamTx = mocks.bootstrapOrgIAM.mock.calls[0]?.[0]?.tx;
    const wsTx = mocks.bootstrapWorkspace.mock.calls[0]?.[0]?.tx;
    expect(iamTx).toBeDefined();
    expect(wsTx).toBe(iamTx);

    expect(mocks.bootstrapOrgIAM).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "internal_org_id",
        ownerUserId: "u_1",
        actorUserId: "u_1",
      }),
    );
    expect(mocks.bootstrapWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "internal_org_id",
        userId: "u_1",
        name: "Core",
        slug: "core",
      }),
    );
  });

  it("creates the Default workspace when the input names none", async () => {
    const input = organizationCreate.input.parse({
      name: "Acme Corp",
      slug: "acme",
    });
    mocks.bootstrapWorkspace.mockResolvedValueOnce({
      ...WORKSPACE_ROW,
      name: "Default",
      slug: "default",
    });

    const result = await organizationCreateHandler(input, CTX);

    expect(mocks.bootstrapWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Default", slug: "default" }),
    );
    expect(result.workspace.slug).toBe("default");
  });

  it("surfaces a workspace bootstrap failure so the org transaction cannot commit without it", async () => {
    mocks.bootstrapWorkspace.mockRejectedValueOnce(
      new Error("workspace insert returned no row"),
    );

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toThrow(
      "workspace insert returned no row",
    );
  });
});
