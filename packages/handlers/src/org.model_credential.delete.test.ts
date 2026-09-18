import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  invalidate: vi.fn(),
  emit: vi.fn(),
}));

/** Minimal Drizzle chain double: .update().set().where() records the values. */
function makeTx() {
  return {
    query: { modelCredentials: { findFirst: mocks.findFirst } },
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          mocks.update(values);
        },
      }),
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/model-credential", () => ({
  invalidateModelCredentialCache: mocks.invalidate,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emit,
}));

import { orgModelCredentialDeleteHandler } from "./org.model_credential.delete";
// The org-role gate every model-credential handler asserts (INV-29). Allows
// by default — an org Admin — so each case below tests its own behaviour;
// the refusal cases set `roleGate.refuse` and assert nothing else ran.
const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Admin";
  }),
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { orgModelCredentialDelete } from "@oxagen/oxagen/contracts/org.model_credential.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const LIVE_ROW = {
  id: "row-1",
  orgId: CTX.orgId,
  provider: "openrouter",
  status: "active",
  keyHint: "wxyz",
  deletedAt: null,
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

describe("org.model_credential.delete handler — a key was stored", () => {
  it("soft-deletes the live row, stamping who removed it", async () => {
    mocks.findFirst.mockResolvedValue(LIVE_ROW);
    await orgModelCredentialDeleteHandler({}, CTX);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const written = mocks.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.deletedAt).toBeInstanceOf(Date);
    expect(written.deletedById).toBe(CTX.userId);
    expect(written.updatedById).toBe(CTX.userId);
  });

  it("invalidates the resolver cache for exactly this org", async () => {
    mocks.findFirst.mockResolvedValue(LIVE_ROW);
    await orgModelCredentialDeleteHandler({}, CTX);
    expect(mocks.invalidate).toHaveBeenCalledWith(CTX.orgId);
  });

  it("emits a model_credential.revoked security event", async () => {
    mocks.findFirst.mockResolvedValue(LIVE_ROW);
    await orgModelCredentialDeleteHandler({}, CTX);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    const event = mocks.emit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.eventType).toBe("model_credential.revoked");
    expect(event.capability).toBe("delete_model_credential");
    expect(event.outcome).toBe("success");
    expect(event.orgId).toBe(CTX.orgId);
    expect(event.actorUserId).toBe(CTX.userId);
    expect(event.workspaceId).toBeNull();
    expect(event.requestId).toBe(CTX.requestId);
  });

  it("returns the not-configured view the contract declares", async () => {
    mocks.findFirst.mockResolvedValue(LIVE_ROW);
    const out = await orgModelCredentialDeleteHandler({}, CTX);
    expect(() => orgModelCredentialDelete.output.parse(out)).not.toThrow();
    expect(out).toEqual({
      configured: false,
      provider: null,
      status: null,
      keyHint: null,
      baseUrl: null,
      modelMap: {},
      lastVerifiedAt: null,
      rotatedAt: null,
    });
  });
});

describe("org.model_credential.delete handler — nothing was stored", () => {
  it("is idempotent: writes nothing and still returns not-configured", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const out = await orgModelCredentialDeleteHandler({}, CTX);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(out.configured).toBe(false);
  });

  it("emits NO security event — a revoked row means a key actually stopped paying", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgModelCredentialDeleteHandler({}, CTX);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("still invalidates the cache, so the resolver's answer is the one just asked for", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await orgModelCredentialDeleteHandler({}, CTX);
    expect(mocks.invalidate).toHaveBeenCalledWith(CTX.orgId);
  });
});

describe("org.model_credential.delete handler — the role gate", () => {
  it("refuses a non-admin before removing anything", async () => {
    roleGate.refuse = true;
    try {
      await expect(orgModelCredentialDeleteHandler({}, CTX)).rejects.toThrow(
        /forbidden/,
      );
      expect(mocks.invalidate).not.toHaveBeenCalled();
    } finally {
      roleGate.refuse = false;
    }
  });
});
