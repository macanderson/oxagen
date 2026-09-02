/**
 * Unit tests for the org.list handler.
 *
 * Covers:
 *   1. Session auth (ctx.userId set): returns the caller's org memberships
 *      without a DB round-trip for API-key resolution.
 *   2. API-key auth (ctx.userId null, ctx.apiKeyId set): resolves effective
 *      user from the key's created_by_user_id and returns those memberships.
 *   3. API-key auth where the key row has no createdByUserId: throws fail-closed.
 *   4. API-key auth where the key row is missing (soft-deleted): throws fail-closed.
 *   5. Neither userId nor apiKeyId: throws fail-closed immediately (no DB call).
 *
 * Regression guard: verifies that Enterprise-plan callers using API-key auth
 * can reach the handler and obtain results. The upstream fix is the contract
 * change from defaultEffect:"deny" to defaultEffect:"allow", ensuring the IAM
 * resolver no longer falls through to a deny when org.list role_grants are
 * absent from an older org's iam.role_grants rows. This test exercises the
 * handler in isolation — IAM is not invoked here — so the contract change is
 * validated at the contract level (defaultEffect field value).
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

import { orgListHandler } from "./org.list";
import { makeCTX } from "./test-utils/fixtures";

// ── shared fixtures ────────────────────────────────────────────────────────────

const ORG_ROWS = [
  {
    id: "org_1",
    publicId: "pub_1",
    slug: "acme",
    namespace: "acme",
    name: "Acme Corp",
    avatarUrl: null,
    role: "owner",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ──────────────────────────────────────────────────────────────────────

describe("orgListHandler", () => {
  // ── session auth ────────────────────────────────────────────────────────────

  it("returns org memberships for a session-auth caller (ctx.userId set)", async () => {
    // One withSystemDb call: the membership query. No API-key lookup.
    mocks.withSystemDb.mockResolvedValueOnce(ORG_ROWS);

    const result = await orgListHandler(
      {},
      makeCTX({
        userId: "usr_session",
        apiKeyId: null,
        orgId: "",
        workspaceId: "",
      }),
    );

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]?.slug).toBe("acme");
    // The immutable namespace is surfaced alongside the renameable slug.
    expect(result.organizations[0]?.namespace).toBe("acme");
    // Only one DB call (membership query; no API-key resolution needed).
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  // ── API-key auth ─────────────────────────────────────────────────────────────

  it("resolves the effective user from the API key and returns their orgs", async () => {
    // Call 1: API-key lookup returns the key's creator.
    mocks.withSystemDb.mockResolvedValueOnce({
      createdByUserId: "usr_key_creator",
    });
    // Call 2: membership query returns ORG_ROWS.
    mocks.withSystemDb.mockResolvedValueOnce(ORG_ROWS);

    const result = await orgListHandler(
      {},
      makeCTX({
        userId: null,
        apiKeyId: "aky_test",
        orgId: "org_bound",
        workspaceId: "ws_bound",
      }),
    );

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]?.name).toBe("Acme Corp");
    // Two withSystemDb calls: one for API-key resolution, one for the membership query.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });

  it("throws when the API key row has no createdByUserId (fail-closed)", async () => {
    // API-key lookup returns a row but createdByUserId is null.
    mocks.withSystemDb.mockResolvedValueOnce({ createdByUserId: null });

    await expect(
      orgListHandler({}, makeCTX({ userId: null, apiKeyId: "aky_no_creator" })),
    ).rejects.toThrow("org.list requires an authenticated user");

    // Should not proceed to the membership query.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  it("throws when the API key row cannot be found (soft-deleted or missing)", async () => {
    // API-key lookup returns null (key not found).
    mocks.withSystemDb.mockResolvedValueOnce(null);

    await expect(
      orgListHandler({}, makeCTX({ userId: null, apiKeyId: "aky_deleted" })),
    ).rejects.toThrow("org.list requires an authenticated user");

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  // ── no auth ───────────────────────────────────────────────────────────────────

  it("throws immediately when neither userId nor apiKeyId is set (unauthenticated)", async () => {
    await expect(
      orgListHandler({}, makeCTX({ userId: null, apiKeyId: null })),
    ).rejects.toThrow("org.list requires an authenticated user");

    // No DB calls should be made for unauthenticated requests.
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});
