import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  del: vi.fn(),
  readRequired: vi.fn(),
  countVerified: vi.fn(),
  upsertRequired: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emit,
}));
vi.mock("./lib/sso-store", () => ({
  deleteOrgSsoProvider: mocks.del,
  readOrgSsoRequired: mocks.readRequired,
  countVerifiedOrgSsoProviders: mocks.countVerified,
  upsertOrgSsoRequired: mocks.upsertRequired,
}));

// The org-role gate every SSO handler asserts (INV-29). Allows by default, an
// org Admin, so each case tests its own behaviour; the refusal case sets
// `roleGate.refuse` and asserts nothing else ran.
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

import { orgSsoDeleteHandler } from "./org.sso.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { SSO_BASE_URL, ssoRow } from "./test-utils/sso-fixtures";

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
  process.env.BETTER_AUTH_URL = SSO_BASE_URL;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
  mocks.del.mockResolvedValue(ssoRow({ domainVerified: true }));
  mocks.readRequired.mockResolvedValue(false);
  mocks.countVerified.mockResolvedValue(0);
});

describe("org.sso.delete handler", () => {
  it("refuses a caller who is not an org Owner or Admin", async () => {
    roleGate.refuse = true;
    await expect(
      orgSsoDeleteHandler({ providerId: "acme" }, CTX),
    ).rejects.toThrow(/forbidden/);
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("deletes the provider pinned to the caller's organisation and emits sso.provider_deleted", async () => {
    await expect(
      orgSsoDeleteHandler({ providerId: "acme" }, CTX),
    ).resolves.toEqual({ deleted: true });
    expect(mocks.del).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      "acme",
    );
    expect(mocks.upsertRequired).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.provider_deleted",
        capability: "delete_sso_provider",
        detail: { providerId: "acme", protocol: "oidc", domain: "acme.com" },
      }),
    );
  });

  it("reads a missing provider as not found", async () => {
    mocks.del.mockResolvedValue(null);
    await expect(
      orgSsoDeleteHandler({ providerId: "acme" }, CTX),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("turns the SSO requirement off in the same transaction when no verified provider remains", async () => {
    mocks.readRequired.mockResolvedValue(true);
    mocks.countVerified.mockResolvedValue(0);
    await orgSsoDeleteHandler({ providerId: "acme" }, CTX);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.upsertRequired).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      false,
      CTX.userId,
    );
    const types = mocks.emit.mock.calls.map((c) => c[0].eventType);
    expect(types).toEqual(["sso.provider_deleted", "sso.policy_updated"]);
    expect(mocks.emit.mock.calls[1]![0].detail).toEqual({ ssoRequired: false });
  });

  it("keeps the requirement while another verified provider remains", async () => {
    mocks.readRequired.mockResolvedValue(true);
    mocks.countVerified.mockResolvedValue(1);
    await orgSsoDeleteHandler({ providerId: "acme" }, CTX);
    expect(mocks.upsertRequired).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });
});
