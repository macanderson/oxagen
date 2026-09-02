/**
 * Unit tests for the workspace.list handler.
 *
 * Mirrors org.list.test.ts: workspace.list received the same API-key auth fix
 * (the CLI calls it immediately after org.list and would otherwise hit the
 * identical IAM-no_grant / null-userId 403). Covers session auth, API-key
 * creator resolution, and the fail-closed paths. The upstream contract fix is
 * defaultEffect:"deny" -> "allow" on workspace.list; this exercises the handler
 * in isolation (IAM is not invoked here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ──────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { workspaceListHandler } from "./workspace.list";
import { makeCTX } from "./test-utils/fixtures";

// ── shared fixtures ────────────────────────────────────────────────────────────

const LIST_RESULT = {
  organization: {
    id: "org_1",
    publicId: "pub_1",
    slug: "acme",
    namespace: "acme",
    name: "Acme Corp",
  },
  workspaces: [
    {
      id: "ws_1",
      publicId: "wpub_1",
      slug: "core",
      namespace: "core",
      name: "Core",
      role: "admin",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ──────────────────────────────────────────────────────────────────────

describe("workspaceListHandler", () => {
  // ── session auth ────────────────────────────────────────────────────────────

  it("returns workspaces for a session-auth caller (ctx.userId set)", async () => {
    // One withSystemDb call: the org+membership+listing transaction. No API-key lookup.
    mocks.withSystemDb.mockResolvedValueOnce(LIST_RESULT);

    const result = await workspaceListHandler(
      { orgSlug: "acme" },
      makeCTX({
        userId: "usr_session",
        apiKeyId: null,
        orgId: "",
        workspaceId: "",
      }),
    );

    expect(result.workspaces).toHaveLength(1);
    expect(result.organization.slug).toBe("acme");
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  // ── API-key auth ─────────────────────────────────────────────────────────────

  it("resolves the effective user from the API key and returns their workspaces", async () => {
    // Call 1: API-key lookup returns the key's creator.
    mocks.withSystemDb.mockResolvedValueOnce({
      createdByUserId: "usr_key_creator",
    });
    // Call 2: org+membership+listing transaction.
    mocks.withSystemDb.mockResolvedValueOnce(LIST_RESULT);

    const result = await workspaceListHandler(
      { orgSlug: "acme" },
      makeCTX({
        userId: null,
        apiKeyId: "aky_test",
        orgId: "org_bound",
        workspaceId: "ws_bound",
      }),
    );

    expect(result.workspaces[0]?.name).toBe("Core");
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });

  it("throws when the API key row has no createdByUserId (fail-closed)", async () => {
    mocks.withSystemDb.mockResolvedValueOnce({ createdByUserId: null });

    await expect(
      workspaceListHandler(
        { orgSlug: "acme" },
        makeCTX({ userId: null, apiKeyId: "aky_no_creator" }),
      ),
    ).rejects.toThrow("workspace.list requires an authenticated user");

    // Should not proceed to the listing transaction.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  it("throws when the API key row cannot be found (soft-deleted or missing)", async () => {
    mocks.withSystemDb.mockResolvedValueOnce(null);

    await expect(
      workspaceListHandler(
        { orgSlug: "acme" },
        makeCTX({ userId: null, apiKeyId: "aky_deleted" }),
      ),
    ).rejects.toThrow("workspace.list requires an authenticated user");

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  // ── no auth ───────────────────────────────────────────────────────────────────

  it("throws immediately when neither userId nor apiKeyId is set (unauthenticated)", async () => {
    await expect(
      workspaceListHandler(
        { orgSlug: "acme" },
        makeCTX({ userId: null, apiKeyId: null }),
      ),
    ).rejects.toThrow("workspace.list requires an authenticated user");

    // No DB calls for unauthenticated requests.
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});
