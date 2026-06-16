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

  it("maps the workspace row, pulling description from the settings bag", async () => {
    mocks.findFirst.mockResolvedValue({
      name: "Research",
      slug: "research",
      settings: { description: "R&D workspace", promptConfig: { x: 1 } },
    });
    const out = await workspaceSettingsReadHandler({}, CTX);
    expect(out).toEqual({ name: "Research", slug: "research", description: "R&D workspace" });
  });

  it("returns null description when the settings bag has none", async () => {
    mocks.findFirst.mockResolvedValue({ name: "W", slug: "w", settings: {} });
    const out = await workspaceSettingsReadHandler({}, CTX);
    expect(out.description).toBeNull();
  });

  it("throws when the workspace is not found", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(workspaceSettingsReadHandler({}, CTX)).rejects.toThrow("Workspace not found");
  });
});
