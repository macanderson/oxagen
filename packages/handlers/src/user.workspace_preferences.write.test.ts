import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(),
  onConflict: vi.fn(),
  findFirst: vi.fn(),
}));

mocks.onConflict.mockResolvedValue([]);
mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflict });

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    insert: (_t: unknown) => ({ values: mocks.insertValues }),
    query: { workspaceUserPreferences: { findFirst: mocks.findFirst } },
  };
  return {
    ...real,
    withTenantDb: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
});

import { userWorkspacePreferencesWriteHandler } from "./user.workspace_preferences.write";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

/** The captured upsert `set` payload (2nd arg to onConflictDoUpdate). */
function capturedSet(): Record<string, unknown> {
  const arg = mocks.onConflict.mock.calls[0]?.[0] as { set: Record<string, unknown> };
  return arg.set;
}
/** The captured insert `values` payload. */
function capturedInsert(): Record<string, unknown> {
  return mocks.insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
}

const STORED = {
  defaultRepoConnectionId: "con_abc",
  defaultRepoSlug: "acme/api",
  defaultEnvironmentId: "env_prod",
  repoDefaultPromptedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("userWorkspacePreferencesWriteHandler", () => {
  beforeEach(() => {
    mocks.insertValues.mockClear();
    mocks.onConflict.mockClear();
    mocks.findFirst.mockReset();
    mocks.onConflict.mockResolvedValue([]);
    mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflict });
    mocks.findFirst.mockResolvedValue(STORED);
  });

  it("throws when there is no authenticated user", async () => {
    const anon: CapabilityContext = { ...CTX, userId: null };
    await expect(
      userWorkspacePreferencesWriteHandler({ defaultRepoConnectionId: "con_x" }, anon),
    ).rejects.toThrow(/authenticated user/);
  });

  it("throws when there is no workspace context", async () => {
    const noWs: CapabilityContext = { ...CTX, workspaceId: null as unknown as string };
    await expect(
      userWorkspacePreferencesWriteHandler({ defaultRepoConnectionId: "con_x" }, noWs),
    ).rejects.toThrow(/workspace context/);
  });

  it("sets the default repo connection + slug in the upsert", async () => {
    await userWorkspacePreferencesWriteHandler(
      { defaultRepoConnectionId: "con_new", defaultRepoSlug: "acme/web" },
      CTX,
    );
    const set = capturedSet();
    expect(set.defaultRepoConnectionId).toBe("con_new");
    expect(set.defaultRepoSlug).toBe("acme/web");
    // Not-provided fields are absent from the partial update set.
    expect("defaultEnvironmentId" in set).toBe(false);
    expect("repoDefaultPromptedAt" in set).toBe(false);
  });

  it("clears a default when explicitly passed null (vs omitting)", async () => {
    await userWorkspacePreferencesWriteHandler({ defaultRepoConnectionId: null }, CTX);
    const set = capturedSet();
    expect("defaultRepoConnectionId" in set).toBe(true);
    expect(set.defaultRepoConnectionId).toBeNull();
  });

  it("stamps repoDefaultPromptedAt when markRepoPrompted=true", async () => {
    await userWorkspacePreferencesWriteHandler({ markRepoPrompted: true }, CTX);
    const set = capturedSet();
    expect(set.repoDefaultPromptedAt).toBeInstanceOf(Date);
    // Also seeded into the insert path for the first-write case.
    expect(capturedInsert().repoDefaultPromptedAt).toBeInstanceOf(Date);
  });

  it("does NOT stamp repoDefaultPromptedAt when markRepoPrompted is absent", async () => {
    await userWorkspacePreferencesWriteHandler({ defaultEnvironmentId: "env_x" }, CTX);
    expect("repoDefaultPromptedAt" in capturedSet()).toBe(false);
  });

  it("carries orgId, workspaceId and userId into the insert values", async () => {
    await userWorkspacePreferencesWriteHandler({ defaultRepoConnectionId: "con_x" }, CTX);
    const ins = capturedInsert();
    expect(ins.orgId).toBe(CTX.orgId);
    expect(ins.workspaceId).toBe(CTX.workspaceId);
    expect(ins.userId).toBe(CTX.userId);
  });

  it("returns the canonical post-upsert row with derived repoDefaultPrompted", async () => {
    const out = await userWorkspacePreferencesWriteHandler(
      { defaultRepoConnectionId: "con_abc" },
      CTX,
    );
    expect(out).toEqual({
      defaultRepoConnectionId: "con_abc",
      defaultRepoSlug: "acme/api",
      defaultEnvironmentId: "env_prod",
      repoDefaultPrompted: true,
    });
  });

  it("throws if the re-read finds no row after upsert", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    await expect(
      userWorkspacePreferencesWriteHandler({ defaultRepoConnectionId: "con_x" }, CTX),
    ).rejects.toThrow(/not found on re-read/);
  });
});
