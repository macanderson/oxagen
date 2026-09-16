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
  noOperatorMessage,
  resolveActorOrgRole,
  resolveOperatorUserId,
} from "./api-key-authz";

/**
 * Tx double for the two-query role resolution: the principals lookup
 * (select→from→where→limit) then the role join (select→from→innerJoin→where).
 * `whereArgs` collects both predicates so a test can inspect the second one.
 */
function makeRoleTx(
  principalId: string | null,
  roleNames: string[],
  whereArgs: unknown[],
) {
  let call = 0;
  return {
    select: () => {
      call++;
      const terminal = (rows: unknown[]) => ({
        where: (predicate: unknown) => {
          whereArgs.push(predicate);
          // The principal lookup ends in .limit(); the role join awaits the
          // where clause itself, so the double answers both shapes.
          return Object.assign(Promise.resolve(rows), {
            limit: () => Promise.resolve(rows),
          });
        },
      });
      if (call === 1) {
        return {
          from: () => terminal(principalId ? [{ id: principalId }] : []),
        };
      }
      return {
        from: () => ({
          innerJoin: () =>
            terminal(roleNames.map((roleName) => ({ roleName }))),
        }),
      };
    },
  };
}

function stubRoleResolution(
  principalId: string | null,
  roleName: string | string[] | null,
) {
  const whereArgs: unknown[] = [];
  const roleNames = [roleName ?? []].flat();
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeRoleTx(principalId, roleNames, whereArgs))),
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

  it("prefers an authorized role when the principal holds several", async () => {
    // Whichever row Postgres returned first used to win, so an Admin who is
    // also a Member was refused depending on row order.
    stubRoleResolution("prn_1", ["Member", "Admin"]);
    expect(await resolveActorOrgRole("org_1", "user_1")).toBe("Admin");
    stubRoleResolution("prn_1", ["Viewer", "Member"]);
    expect(await resolveActorOrgRole("org_1", "user_1")).toBe("Viewer");
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

describe("resolveOperatorUserId", () => {
  const ORG = "org_1";
  /** The row `oxagen login` writes: empty scope, its approver as creator. */
  const CLI_KEY = {
    scope: {},
    createdByUserId: "user_cli",
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
    stubKey({ ...CLI_KEY, createdByUserId: null });
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
