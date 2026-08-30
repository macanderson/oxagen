import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { workspaces: { findFirst: mocks.findFirst } } }),
  };
});

import { workspaceSettingsReadHandler } from "./workspace.settings.read";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workspace.settings.read handler", () => {
  beforeEach(() => mocks.findFirst.mockReset());

  it("maps the workspace row, pulling description and avatarUrl from their columns", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "Research",
      slug: "research",
      avatarUrl: 'avatar:v1:{"emoji":"🔬","bg":"#2563eb","mode":"full"}',
      description: "R&D workspace",
    });
    const out = await workspaceSettingsReadHandler({}, CTX);
    expect(out).toEqual({
      name: "Research",
      slug: "research",
      description: "R&D workspace",
      avatarUrl: 'avatar:v1:{"emoji":"🔬","bg":"#2563eb","mode":"full"}',
    });
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
