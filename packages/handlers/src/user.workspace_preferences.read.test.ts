/**
 * Unit tests for get_workspace_user_preferences (read) handler.
 *
 * Strategy: mock withTenantDb so no DB is needed. Covers the row-present and
 * row-absent (defaults) paths, the repoDefaultPrompted derivation, and the
 * auth/workspace context guards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { userWorkspacePreferencesReadHandler } from "./user.workspace_preferences.read";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

function makeReadTx(row: Record<string, unknown> | undefined) {
  return {
    query: {
      workspaceUserPreferences: {
        findFirst: vi.fn().mockResolvedValue(row),
      },
    },
  };
}

describe("userWorkspacePreferencesReadHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stored defaults and repoDefaultPrompted=true when a row exists with a prompt timestamp", async () => {
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(
          makeReadTx({
            defaultRepoConnectionId: "con_abc",
            defaultRepoSlug: "acme/web",
            defaultEnvironmentId: "env_1",
            repoDefaultPromptedAt: new Date(),
          }),
        ),
    );

    const result = await userWorkspacePreferencesReadHandler({}, TEST_CTX);

    expect(result).toEqual({
      defaultRepoConnectionId: "con_abc",
      defaultRepoSlug: "acme/web",
      defaultEnvironmentId: "env_1",
      repoDefaultPrompted: true,
    });
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("derives repoDefaultPrompted=false when the timestamp is null", async () => {
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(
          makeReadTx({
            defaultRepoConnectionId: "con_abc",
            defaultRepoSlug: null,
            defaultEnvironmentId: null,
            repoDefaultPromptedAt: null,
          }),
        ),
    );

    const result = await userWorkspacePreferencesReadHandler({}, TEST_CTX);
    expect(result.repoDefaultPrompted).toBe(false);
    expect(result.defaultRepoConnectionId).toBe("con_abc");
    expect(result.defaultRepoSlug).toBeNull();
  });

  it("returns all-null defaults and repoDefaultPrompted=false when no row exists", async () => {
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(makeReadTx(undefined)),
    );

    const result = await userWorkspacePreferencesReadHandler({}, TEST_CTX);

    expect(result).toEqual({
      defaultRepoConnectionId: null,
      defaultRepoSlug: null,
      defaultEnvironmentId: null,
      repoDefaultPrompted: false,
    });
  });

  it("throws before any DB access when userId is missing", async () => {
    const noUser = makeCTX({ userId: null });
    await expect(
      userWorkspacePreferencesReadHandler({}, noUser),
    ).rejects.toThrow("requires an authenticated user");
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("throws before any DB access when workspaceId is missing", async () => {
    const noWs = makeCTX({ workspaceId: undefined as unknown as string });
    await expect(
      userWorkspacePreferencesReadHandler({}, noWs),
    ).rejects.toThrow("requires a workspace context");
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
