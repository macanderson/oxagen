import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { workspaceUserPreferences: { findFirst: mocks.findFirst } } }),
  };
});

import { userWorkspacePreferencesReadHandler } from "./user.workspace_preferences.read";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("userWorkspacePreferencesReadHandler", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
  });

  it("throws when there is no authenticated user", async () => {
    const anon: CapabilityContext = { ...CTX, userId: null };
    await expect(userWorkspacePreferencesReadHandler({}, anon)).rejects.toThrow(
      /authenticated user/,
    );
  });

  it("throws when there is no workspace context", async () => {
    const noWs: CapabilityContext = { ...CTX, workspaceId: null };
    await expect(userWorkspacePreferencesReadHandler({}, noWs)).rejects.toThrow(
      /workspace context/,
    );
  });

  it("returns defaults (never prompted) when no row exists", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const out = await userWorkspacePreferencesReadHandler({}, CTX);
    expect(out).toEqual({
      defaultRepoConnectionId: null,
      defaultRepoSlug: null,
      defaultEnvironmentId: null,
      repoDefaultPrompted: false,
    });
  });

  it("maps a stored row, deriving repoDefaultPrompted from the timestamp", async () => {
    mocks.findFirst.mockResolvedValue({
      defaultRepoConnectionId: "con_abc",
      defaultRepoSlug: "acme/api",
      defaultEnvironmentId: "env_prod",
      repoDefaultPromptedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const out = await userWorkspacePreferencesReadHandler({}, CTX);
    expect(out).toEqual({
      defaultRepoConnectionId: "con_abc",
      defaultRepoSlug: "acme/api",
      defaultEnvironmentId: "env_prod",
      repoDefaultPrompted: true,
    });
  });

  it("reports repoDefaultPrompted=false when the timestamp is null", async () => {
    mocks.findFirst.mockResolvedValue({
      defaultRepoConnectionId: null,
      defaultRepoSlug: null,
      defaultEnvironmentId: null,
      repoDefaultPromptedAt: null,
    });
    const out = await userWorkspacePreferencesReadHandler({}, CTX);
    expect(out.repoDefaultPrompted).toBe(false);
  });
});
