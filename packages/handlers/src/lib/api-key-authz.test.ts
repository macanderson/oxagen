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

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  gt: vi.fn((col: unknown, val: unknown) => ({ __gt: [col, val] })),
  isNull: vi.fn((col: unknown) => ({ __isNull: col })),
}));

// generateApiKey is pure crypto, but the module imports @oxagen/database for its
// sibling role-resolution helpers. Pass the real module through (so no DB pool is
// touched at import time — mirrors api.key.create.test.ts) with only
// withTenantDb replaced, so the role queries run against a tx double.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

// Capture the expiry predicates without depending on Drizzle SQL internals.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, gt: mocks.gt, isNull: mocks.isNull };
});

import { schema } from "@oxagen/database";
import {
  actorCanManageApiKeys,
  generateApiKey,
  resolveActorOrgRole,
} from "./api-key-authz";

/**
 * Tx double for the two-query role resolution: the principals lookup
 * (select→from→where→limit) then the role join (select→from→innerJoin→where→limit).
 * `whereArgs` collects both predicates so a test can inspect the second one.
 */
function makeRoleTx(
  principalId: string | null,
  roleName: string | null,
  whereArgs: unknown[],
) {
  let call = 0;
  return {
    select: () => {
      call++;
      const terminal = (rows: unknown[]) => ({
        where: (predicate: unknown) => {
          whereArgs.push(predicate);
          return { limit: () => Promise.resolve(rows) };
        },
      });
      if (call === 1) {
        return {
          from: () => terminal(principalId ? [{ id: principalId }] : []),
        };
      }
      return {
        from: () => ({
          innerJoin: () => terminal(roleName ? [{ roleName }] : []),
        }),
      };
    },
  };
}

function stubRoleResolution(
  principalId: string | null,
  roleName: string | null,
) {
  const whereArgs: unknown[] = [];
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeRoleTx(principalId, roleName, whereArgs))),
  );
  return whereArgs;
}

describe("resolveActorOrgRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the user has no active principal in the org", async () => {
    stubRoleResolution(null, null);
    expect(await resolveActorOrgRole("org_1", "user_1")).toBeNull();
  });

  it("returns null when the principal holds no org-scoped role", async () => {
    stubRoleResolution("prn_1", null);
    expect(await resolveActorOrgRole("org_1", "user_1")).toBeNull();
  });

  it("returns the assigned org role name", async () => {
    stubRoleResolution("prn_1", "Admin");
    expect(await resolveActorOrgRole("org_1", "user_1")).toBe("Admin");
  });

  it("excludes expired (JIT) role assignments from the role lookup", async () => {
    // A time-bounded Admin grant that has lapsed must stop granting Admin, the
    // same way the kernel resolver's isExpired() treats an expired grant.
    stubRoleResolution("prn_1", "Admin");
    await resolveActorOrgRole("org_1", "user_1");

    expect(mocks.isNull).toHaveBeenCalledWith(
      schema.principalRoleAssignments.expiresAt,
    );
    const gtCall = mocks.gt.mock.calls.find(
      ([col]) => col === schema.principalRoleAssignments.expiresAt,
    );
    expect(gtCall).toBeDefined();
    expect(gtCall?.[1]).toBeInstanceOf(Date);
  });
});

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
      stubRoleResolution("prn_1", roleName);
      expect(await actorCanManageApiKeys("org_1", "user_1")).toBe(allowed);
    });
  }

  it("denies a user with no role at all", async () => {
    stubRoleResolution("prn_1", null);
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
