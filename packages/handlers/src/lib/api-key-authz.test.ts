/**
 * Unit tests for generateApiKey() — the API-key minting helper — and for the
 * operator resolution the Tacho capabilities gate on.
 *
 * Critical invariant: `keyPrefix` is the FIXED 12-char leading window of the
 * raw key. This window length MUST match @oxagen/auth's `API_KEY_PREFIX_LENGTH`,
 * which resolveApiKey() uses to look the key up. A drift here — or a "_"-split
 * on the verify side — rejects every key. This file pins the mint side of that
 * contract (the verify side is pinned in
 * packages/auth/src/resolvers/resolvers.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

// The org-role query itself is tested where it lives
// (packages/iam/src/org-role.test.ts); here it is replaced so the predicate's
// mapping from a role name to a yes/no is what runs.
const mocks = vi.hoisted(() => ({
  resolveActorOrgRole: vi.fn(),
  withTenantDb: vi.fn(),
  isNull: vi.fn((col: unknown) => ({ __isNull: col })),
}));

vi.mock("@oxagen/iam/org-role", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/iam/org-role")>();
  return { ...real, resolveActorOrgRole: mocks.resolveActorOrgRole };
});

// generateApiKey is pure crypto, but the module imports @oxagen/database for
// the operator lookup. Pass the real module through (so no DB pool is touched
// at import time — mirrors api.key.create.test.ts) with only withTenantDb
// replaced, so the key lookup runs against a tx double.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

// Capture the liveness predicate without depending on Drizzle SQL internals.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, isNull: mocks.isNull };
});

import { schema } from "@oxagen/database";
import {
  actorCanManageApiKeys,
  generateApiKey,
  noOperatorMessage,
  resolveOperatorUserId,
} from "./api-key-authz";

describe("actorCanManageApiKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases: Array<{ roleName: string; allowed: boolean }> = [
    { roleName: "Owner", allowed: true },
    { roleName: "Admin", allowed: true },
    { roleName: "Member", allowed: false },
    { roleName: "Viewer", allowed: false },
  ];

  for (const { roleName, allowed } of cases) {
    it(`role ${roleName} → ${allowed}`, async () => {
      mocks.resolveActorOrgRole.mockResolvedValue(roleName);
      expect(await actorCanManageApiKeys("org_1", "user_1")).toBe(allowed);
      expect(mocks.resolveActorOrgRole).toHaveBeenCalledWith("org_1", "user_1");
    });
  }

  it("denies a user with no role at all", async () => {
    mocks.resolveActorOrgRole.mockResolvedValue(null);
    expect(await actorCanManageApiKeys("org_1", "user_1")).toBe(false);
  });
});

describe("resolveOperatorUserId", () => {
  const ORG = "org_1";
  /** The row `oxagen login` writes: empty scope, its approver as creator. */
  const CLI_KEY = {
    scope: {},
    createdById: "user_cli",
    stellaTelemetryEnrollmentId: null,
  };
  const KEY_CTX = { orgId: ORG, userId: null, apiKeyId: "key_1" };

  function stubKey(row: Record<string, unknown> | undefined) {
    const findFirst = vi.fn(async () => row);
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      Promise.resolve(fn({ query: { apiKeys: { findFirst } } })),
    );
    return findFirst;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the session user without reading any key", async () => {
    const findFirst = stubKey(CLI_KEY);
    expect(
      await resolveOperatorUserId({ ...KEY_CTX, userId: "user_session" }),
    ).toBe("user_session");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("acts for the user who minted an `oxagen login` key", async () => {
    stubKey(CLI_KEY);
    expect(await resolveOperatorUserId(KEY_CTX)).toBe("user_cli");
    expect(mocks.isNull).toHaveBeenCalledWith(schema.apiKeys.deletedAt);
  });

  it("never acts for a key bound to a machine purpose", async () => {
    stubKey({
      ...CLI_KEY,
      scope: { purpose: "tacho_host_v1", host_enrollment_id: "tch_x" },
    });
    expect(await resolveOperatorUserId(KEY_CTX)).toBeNull();
    stubKey({ ...CLI_KEY, scope: { purpose: "a_purpose_added_later" } });
    expect(await resolveOperatorUserId(KEY_CTX)).toBeNull();
    stubKey({ ...CLI_KEY, stellaTelemetryEnrollmentId: "sten_1" });
    expect(await resolveOperatorUserId(KEY_CTX)).toBeNull();
  });

  it("returns null for an unknown or revoked key, a key with no creator, or no credential", async () => {
    stubKey(undefined);
    expect(await resolveOperatorUserId(KEY_CTX)).toBeNull();
    stubKey({ ...CLI_KEY, createdById: null });
    expect(await resolveOperatorUserId(KEY_CTX)).toBeNull();
    const findFirst = stubKey(CLI_KEY);
    expect(
      await resolveOperatorUserId({ ...KEY_CTX, apiKeyId: null }),
    ).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("words the refusal for the credential that was presented", () => {
    expect(noOperatorMessage(KEY_CTX)).toMatch(
      /API key does not act for a person/,
    );
    expect(noOperatorMessage({ ...KEY_CTX, apiKeyId: null })).toBe(
      "Unauthorized: no authenticated user",
    );
  });
});

describe("generateApiKey", () => {
  it("produces a raw key in the ox_<base64url> format", () => {
    const { rawKey } = generateApiKey();
    expect(rawKey).toMatch(/^ox_[A-Za-z0-9_-]+$/);
  });

  it("stores keyPrefix as the fixed 12-char leading window of the raw key", () => {
    const { rawKey, keyPrefix } = generateApiKey();
    // 12 === @oxagen/auth API_KEY_PREFIX_LENGTH. resolveApiKey() looks the key up
    // by exactly this leading window; any divergence rejects the key.
    expect(keyPrefix).toBe(rawKey.slice(0, 12));
    expect(keyPrefix).toHaveLength(12);
    expect(keyPrefix.startsWith("ox_")).toBe(true);
  });

  it("keyHash is the SHA-256 hex digest of the full raw key", () => {
    const { rawKey, keyHash } = generateApiKey();
    expect(keyHash).toBe(createHash("sha256").update(rawKey).digest("hex"));
    expect(keyHash).toHaveLength(64); // 32-byte digest as hex
  });

  it("produces unique key material across calls", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});
