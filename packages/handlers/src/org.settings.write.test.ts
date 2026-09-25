import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { findFirst: vi.fn(), where, set, update };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: { organizations: { findFirst: mocks.findFirst } },
        update: mocks.update,
      }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// The role gate runs for real against a role fixture, not the tx above.
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

import { isHandlerError } from "@oxagen/oxagen";
import { orgSettingsWriteHandler } from "./org.settings.write";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const ROW = {
  name: "Acme",
  slug: "acme",
  avatarUrl: null,
  website: null,
  industry: null,
  employeeSize: null,
  type: "business",
};

describe("org.settings.write handler", () => {
  beforeEach(() => {
    resetRoleGate();
    mocks.findFirst.mockReset();
    mocks.set.mockClear();
    mocks.update.mockClear();
    mocks.where.mockReset();
    mocks.where.mockResolvedValue(undefined);
  });

  // The contract grants org Owner or Admin and workspace Owner or Admin. The
  // kernel's IAM check allows every capability for a non-enterprise org, so
  // the handler is the only gate there (#4194).
  describe("role gate", () => {
    it("refuses a workspace Member as forbidden, before any read or write", async () => {
      roleGate.roles = { org: null, workspace: "Member" };
      const err = await orgSettingsWriteHandler({ name: "Mine now" }, CTX).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isHandlerError(err)).toBe(true);
      expect(err).toMatchObject({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.findFirst).not.toHaveBeenCalled();
    });

    it.each([
      ["an org Admin", { org: "Admin" }],
      ["a workspace Owner", { org: null, workspace: "Owner" }],
    ])("allows %s", async (_who, roles) => {
      roleGate.roles = roles;
      mocks.findFirst.mockResolvedValue(ROW);
      const out = await orgSettingsWriteHandler({}, CTX);
      expect(out.slug).toBe("acme");
    });
  });

  it("applies only the provided fields and returns the mapped row", async () => {
    mocks.findFirst.mockResolvedValue({
      ...ROW,
      name: "Acme Inc",
      industry: "Tech",
    });
    const out = await orgSettingsWriteHandler(
      { name: "Acme Inc", industry: "Tech" },
      CTX,
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme Inc", industry: "Tech" }),
    );
    expect(out.name).toBe("Acme Inc");
    expect(out.industry).toBe("Tech");
  });

  it("does not issue an update when no fields are provided", async () => {
    mocks.findFirst.mockResolvedValue(ROW);
    const out = await orgSettingsWriteHandler({}, CTX);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(out.slug).toBe("acme");
  });

  it("maps a unique-violation on slug to a friendly error", async () => {
    mocks.where.mockRejectedValueOnce({ code: "23505" });
    await expect(
      orgSettingsWriteHandler({ slug: "taken" }, CTX),
    ).rejects.toThrow(/already in use/);
  });

  it("maps a Drizzle-wrapped unique-violation (code on .cause) to a friendly error", async () => {
    // Production path: drizzle wraps the postgres.js error and the SQLSTATE
    // lives on `.cause`, not the top level. The shared isUniqueViolation walks
    // the cause chain; a top-level-only check would miss this and leak raw SQL.
    mocks.where.mockRejectedValueOnce({
      name: "DrizzleQueryError",
      message: "Failed query: update org.organizations ...",
      cause: { code: "23505", constraint_name: "organizations_slug_idx" },
    });
    await expect(
      orgSettingsWriteHandler({ slug: "taken" }, CTX),
    ).rejects.toThrow(/already in use/);
  });

  it("throws when the organization is not found after update", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(orgSettingsWriteHandler({ name: "X" }, CTX)).rejects.toThrow(
      "Organization not found",
    );
  });
});
