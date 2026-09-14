/**
 * Unit tests for generateApiKey() — the API-key minting helper.
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
}));

vi.mock("@oxagen/iam/org-role", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/iam/org-role")>();
  return { ...real, resolveActorOrgRole: mocks.resolveActorOrgRole };
});

import { actorCanManageApiKeys, generateApiKey } from "./api-key-authz";

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
