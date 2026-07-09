/**
 * Unit tests for update_workspace_user_preferences (write) handler.
 *
 * Strategy: mock withTenantDb so no DB is needed. Covers INSERT (no existing
 * row), UPDATE (existing row), partial update ("in input" semantics), explicit
 * null clears, markRepoPrompted stamping, and the auth/workspace guards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { userWorkspacePreferencesWriteHandler } from "./user.workspace_preferences.write";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

function makeReadTx(existing: Record<string, unknown> | undefined) {
  return {
    query: {
      workspaceUserPreferences: {
        findFirst: vi.fn().mockResolvedValue(existing),
      },
    },
  };
}

/** Captures the values passed to insert(...).values(...). */
function makeInsertTx(capture: { values?: Record<string, unknown> }) {
  return {
    insert: mocks.insertSpy.mockReturnValue({
      values: vi.fn((v: Record<string, unknown>) => {
        capture.values = v;
        return Promise.resolve(undefined);
      }),
    }),
  };
}

/** Captures the values passed to update(...).set(...). */
function makeUpdateTx(capture: { set?: Record<string, unknown> }) {
  return {
    update: mocks.updateSpy.mockReturnValue({
      set: vi.fn((v: Record<string, unknown>) => {
        capture.set = v;
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
  };
}

/**
 * Wire withTenantDb across the handler's three calls: read (existing?), the
 * write (insert or update), and the final re-read (returns `finalRow`).
 */
function wire(
  existing: Record<string, unknown> | undefined,
  writeTx: unknown,
  finalRow: Record<string, unknown>,
) {
  let call = 0;
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      call++;
      if (call === 1) return fn(makeReadTx(existing));
      if (call === 2) return fn(writeTx);
      return fn(makeReadTx(finalRow));
    },
  );
}

describe("userWorkspacePreferencesWriteHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("INSERTs a new row when none exists and returns the re-read state", async () => {
    const cap: { values?: Record<string, unknown> } = {};
    wire(undefined, makeInsertTx(cap), {
      defaultRepoConnectionId: "con_1",
      defaultRepoSlug: "acme/web",
      defaultEnvironmentId: null,
      repoDefaultPromptedAt: null,
    });

    const result = await userWorkspacePreferencesWriteHandler(
      { defaultRepoConnectionId: "con_1", defaultRepoSlug: "acme/web" },
      TEST_CTX,
    );

    expect(mocks.insertSpy).toHaveBeenCalledTimes(1);
    expect(mocks.updateSpy).not.toHaveBeenCalled();
    // Insert carries tenant + user stamping.
    expect(cap.values).toMatchObject({
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: "u_1",
      defaultRepoConnectionId: "con_1",
      defaultRepoSlug: "acme/web",
    });
    expect(result).toEqual({
      defaultRepoConnectionId: "con_1",
      defaultRepoSlug: "acme/web",
      defaultEnvironmentId: null,
      repoDefaultPrompted: false,
    });
  });

  it("UPDATEs an existing row and returns the re-read state", async () => {
    const cap: { set?: Record<string, unknown> } = {};
    wire({ id: "wup_1" }, makeUpdateTx(cap), {
      defaultRepoConnectionId: "con_2",
      defaultRepoSlug: "acme/api",
      defaultEnvironmentId: "env_9",
      repoDefaultPromptedAt: new Date(),
    });

    const result = await userWorkspacePreferencesWriteHandler(
      { defaultEnvironmentId: "env_9" },
      TEST_CTX,
    );

    expect(mocks.updateSpy).toHaveBeenCalledTimes(1);
    expect(mocks.insertSpy).not.toHaveBeenCalled();
    expect(cap.set).toMatchObject({ defaultEnvironmentId: "env_9", updatedByUserId: "u_1" });
    expect(result.defaultEnvironmentId).toBe("env_9");
    expect(result.repoDefaultPrompted).toBe(true);
  });

  it("only mutates fields present in the input (omitted field ⇒ not in the set clause)", async () => {
    const cap: { set?: Record<string, unknown> } = {};
    wire({ id: "wup_2" }, makeUpdateTx(cap), {
      defaultRepoConnectionId: "con_x",
      defaultRepoSlug: "acme/web",
      defaultEnvironmentId: null,
      repoDefaultPromptedAt: null,
    });

    await userWorkspacePreferencesWriteHandler(
      { defaultRepoConnectionId: "con_x" },
      TEST_CTX,
    );

    expect(cap.set).toHaveProperty("defaultRepoConnectionId", "con_x");
    // Untouched fields must be absent from the update set.
    expect(cap.set).not.toHaveProperty("defaultRepoSlug");
    expect(cap.set).not.toHaveProperty("defaultEnvironmentId");
  });

  it("clears a field when null is explicitly supplied", async () => {
    const cap: { set?: Record<string, unknown> } = {};
    wire({ id: "wup_3" }, makeUpdateTx(cap), {
      defaultRepoConnectionId: null,
      defaultRepoSlug: null,
      defaultEnvironmentId: null,
      repoDefaultPromptedAt: null,
    });

    const result = await userWorkspacePreferencesWriteHandler(
      { defaultRepoConnectionId: null },
      TEST_CTX,
    );

    expect(cap.set).toHaveProperty("defaultRepoConnectionId", null);
    expect(result.defaultRepoConnectionId).toBeNull();
  });

  it("stamps repoDefaultPromptedAt when markRepoPrompted is true", async () => {
    const cap: { set?: Record<string, unknown> } = {};
    wire({ id: "wup_4" }, makeUpdateTx(cap), {
      defaultRepoConnectionId: null,
      defaultRepoSlug: null,
      defaultEnvironmentId: null,
      repoDefaultPromptedAt: new Date(),
    });

    const result = await userWorkspacePreferencesWriteHandler(
      { markRepoPrompted: true },
      TEST_CTX,
    );

    expect(cap.set?.repoDefaultPromptedAt).toBeInstanceOf(Date);
    expect(result.repoDefaultPrompted).toBe(true);
  });

  it("throws before any DB access when userId is missing", async () => {
    const noUser = makeCTX({ userId: null });
    await expect(
      userWorkspacePreferencesWriteHandler({ markRepoPrompted: true }, noUser),
    ).rejects.toThrow("requires an authenticated user");
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("throws before any DB access when workspaceId is missing", async () => {
    const noWs = makeCTX({ workspaceId: undefined as unknown as string });
    await expect(
      userWorkspacePreferencesWriteHandler({ markRepoPrompted: true }, noWs),
    ).rejects.toThrow("requires a workspace context");
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
