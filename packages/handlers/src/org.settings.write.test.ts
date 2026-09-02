import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { findFirst: vi.fn(), where, set, update };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: { organizations: { findFirst: mocks.findFirst } },
        update: mocks.update,
      }),
  };
});

import { orgSettingsWriteHandler } from "./org.settings.write";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

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
    mocks.findFirst.mockReset();
    mocks.set.mockClear();
    mocks.update.mockClear();
    mocks.where.mockReset();
    mocks.where.mockResolvedValue(undefined);
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
