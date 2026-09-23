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
      fn({ query: { workspaces: { findFirst: mocks.findFirst } } }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { workspaceSettingsReadHandler } from "./workspace.settings.read";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { DEFAULT_CONSEQUENCE_ROLES } from "@oxagen/oxagen/mandates/schemas";

const { other: _other, ...DEFAULT_CONSEQUENCE_ROLES_WITHOUT_OTHER } =
  DEFAULT_CONSEQUENCE_ROLES;

describe("workspace.settings.read handler", () => {
  beforeEach(() => mocks.findFirst.mockReset());

  it("maps the workspace row, pulling description and avatarUrl from their columns", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "Research",
      slug: "research",
      avatarUrl: 'avatar:v1:{"emoji":"🔬","bg":"#2563eb","mode":"full"}',
      description: "R&D workspace",
      consequenceRoles: { moves_money: ["Billing"], ships_code: ["Admin"] },
    });
    const out = await workspaceSettingsReadHandler({}, CTX);
    expect(out).toEqual({
      name: "Research",
      slug: "research",
      description: "R&D workspace",
      avatarUrl: 'avatar:v1:{"emoji":"🔬","bg":"#2563eb","mode":"full"}',
      consequenceRoles: {
        ...DEFAULT_CONSEQUENCE_ROLES_WITHOUT_OTHER,
        moves_money: ["Billing"],
        ships_code: ["Admin"],
      },
      // Both steering-freshness gates are off until the workspace sets one.
      runEnrichmentEnabled: true,
      steering: { autoSync: false, blockStaleRuns: false },
    });
  });

  it("reads the steering gates out of the settings bag", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "Research",
      slug: "research",
      avatarUrl: null,
      description: null,
      consequenceRoles: {},
      settings: { steering: { blockStaleRuns: true } },
    });
    const out = await workspaceSettingsReadHandler({}, CTX);
    expect(out.steering).toEqual({ autoSync: false, blockStaleRuns: true });
  });

  // A bad value must not take out the checkboxes or the hook that reads them.
  it("reads a steering block that does not parse as both gates off", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "Research",
      slug: "research",
      avatarUrl: null,
      description: null,
      consequenceRoles: {},
      settings: { steering: { blockStaleRuns: "yes please" } },
    });
    const out = await workspaceSettingsReadHandler({}, CTX);
    expect(out.steering).toEqual({ autoSync: false, blockStaleRuns: false });
  });

  it("reads stored overrides that no longer parse as no overrides", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "W",
      slug: "w",
      avatarUrl: null,
      description: null,
      consequenceRoles: { moves_money: "Billing" },
    });
    const out = await workspaceSettingsReadHandler({}, CTX);
    expect(out.consequenceRoles).toEqual(
      DEFAULT_CONSEQUENCE_ROLES_WITHOUT_OTHER,
    );
  });

  it("returns null description and avatarUrl when unset", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "W",
      slug: "w",
      avatarUrl: null,
      description: null,
    });
    const out = await workspaceSettingsReadHandler({}, CTX);
    expect(out.description).toBeNull();
    expect(out.avatarUrl).toBeNull();
  });

  it("throws when the workspace is not found", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(workspaceSettingsReadHandler({}, CTX)).rejects.toThrow(
      "Workspace not found",
    );
  });
});
