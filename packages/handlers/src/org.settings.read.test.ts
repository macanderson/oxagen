import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { organizations: { findFirst: mocks.findFirst } } }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { orgSettingsReadHandler } from "./org.settings.read";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("org.settings.read handler", () => {
  beforeEach(() => mocks.findFirst.mockReset());

  it("maps the organization row to the settings output", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "Acme",
      slug: "acme",
      avatarUrl: null,
      website: "https://acme.com",
      industry: "Technology",
      employeeSize: "11-50",
      type: "business",
    });
    const out = await orgSettingsReadHandler({}, CTX);
    expect(out).toEqual({
      name: "Acme",
      slug: "acme",
      avatarUrl: null,
      website: "https://acme.com",
      industry: "Technology",
      employeeSize: "11-50",
      type: "business",
    });
  });

  it("coerces an out-of-range employeeSize to null and unknown type to business", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "Solo",
      slug: "solo",
      avatarUrl: null,
      website: null,
      industry: null,
      employeeSize: "weird",
      type: "personal",
    });
    const out = await orgSettingsReadHandler({}, CTX);
    expect(out.employeeSize).toBeNull();
    expect(out.type).toBe("personal");
  });

  it("throws when the organization is not found", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(orgSettingsReadHandler({}, CTX)).rejects.toThrow(
      "Organization not found",
    );
  });
});
