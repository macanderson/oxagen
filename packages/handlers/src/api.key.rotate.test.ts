/**
 * Unit tests for api.key.rotate handler.
 *
 * Coverage:
 *   - auth + scope guards (no principal / no org) → CapabilityError authz_denied
 *   - role gate (Member) → CapabilityError authz_denied
 *   - old key not found / already revoked → plain Error("Not found...")
 *   - happy path → returns new rawKey + revokedKeyPublicId + revokedAt
 *   - replacement inherits old name unless overridden; inherits expiry
 *   - emits api_key.created + api_key.revoked; single atomic withTenantDb txn
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CapabilityError } from "@oxagen/oxagen/kernel";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
  generateApiKey: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));
vi.mock("./lib/api-key-authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/api-key-authz")>()),
  generateApiKey: mocks.generateApiKey,
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { apiKeyRotateHandler } from "./api.key.rotate";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

const BASE_INPUT = { keyPublicId: "aky_old123" };

function makeRoleResolutionTx(
  principalId: string | null,
  roleName: string | null,
) {
  let n = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      n++;
      if (n === 1) {
        return {
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve(principalId ? [{ id: principalId }] : []),
            }),
          }),
        };
      }
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve(roleName ? [{ roleName }] : []),
            }),
          }),
        }),
      };
    }),
  };
}

type OldRow = {
  id: string;
  publicId: string;
  name: string;
  scope: Record<string, unknown>;
  expiresAt: Date | null;
  workspaceId: string;
};
type NewRow = {
  id: string;
  publicId: string;
  name: string;
  keyPrefix: string;
  expiresAt: Date | null;
  createdAt: Date;
};

function makeRotateTx(
  oldRow: OldRow | null,
  newRow: NewRow,
  valuesSpy = vi.fn(),
  insertSpy = vi.fn(),
  updateSpy = vi.fn(),
) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(oldRow ? [oldRow] : []) }),
      }),
    }),
    insert: () => {
      insertSpy();
      return {
        values: (v: unknown) => {
          valuesSpy(v);
          return { returning: () => Promise.resolve([newRow]) };
        },
      };
    },
    update: () => {
      updateSpy();
      return { set: () => ({ where: () => Promise.resolve([]) }) };
    },
  };
}

const OLD_ROW: OldRow = {
  id: "key-old-uuid",
  publicId: "aky_old123",
  name: "CI deploy key",
  scope: { env: "prod" },
  expiresAt: new Date("2027-01-01T00:00:00Z"),
  workspaceId: "wrk_1",
};
const NEW_ROW: NewRow = {
  id: "key-new-uuid",
  publicId: "aky_new456",
  name: "CI deploy key",
  keyPrefix: "ox_abcdefgh",
  expiresAt: new Date("2027-01-01T00:00:00Z"),
  createdAt: new Date("2026-06-16T00:00:00Z"),
};

function setupHappyPath(
  roleName = "Owner",
  oldRow: OldRow | null = OLD_ROW,
  newRow: NewRow = NEW_ROW,
  valuesSpy = vi.fn(),
  insertSpy = vi.fn(),
  updateSpy = vi.fn(),
) {
  let call = 0;
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => {
      call++;
      if (call === 1) return fn(makeRoleResolutionTx("principal-1", roleName));
      return fn(makeRotateTx(oldRow, newRow, valuesSpy, insertSpy, updateSpy));
    },
  );
}

beforeEach(() => {
  mocks.generateApiKey.mockReturnValue({
    rawKey: "ox_rotated_secret",
    keyPrefix: "ox_rotated_",
    keyHash: "rotated-hash",
  });
});

describe("api.key.rotate handler — guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it("rejects when no authenticated principal", async () => {
    const anon = makeCTX({ userId: null, apiKeyId: null });
    await expect(apiKeyRotateHandler(BASE_INPUT, anon)).rejects.toSatisfy(
      (e: unknown) => e instanceof CapabilityError && e.code === "authz_denied",
    );
  });

  it("rejects when actor role is insufficient (Member)", async () => {
    vi.clearAllMocks();
    setupHappyPath("Member");
    await expect(apiKeyRotateHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) => e instanceof CapabilityError && e.code === "authz_denied",
    );
  });
});

describe("api.key.rotate handler — not found", () => {
  it("throws a plain Error when the old key does not exist / is revoked", async () => {
    vi.clearAllMocks();
    setupHappyPath("Owner", null);
    await expect(apiKeyRotateHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof Error &&
        !(e instanceof CapabilityError) &&
        /Not found/.test(e.message),
    );
  });
});

describe("api.key.rotate handler — protected Stella telemetry scope", () => {
  it("rejects before generating, inserting, or revoking a protected enrollment key", async () => {
    const insertSpy = vi.fn();
    const updateSpy = vi.fn();
    const protectedRow: OldRow = {
      ...OLD_ROW,
      scope: {
        purpose: "stella_operational_telemetry_v1",
        enrollment_id: "enrollment-1",
      },
    };
    vi.clearAllMocks();
    setupHappyPath(
      "Owner",
      protectedRow,
      NEW_ROW,
      vi.fn(),
      insertSpy,
      updateSpy,
    );

    await expect(
      apiKeyRotateHandler(BASE_INPUT, TEST_CTX),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.generateApiKey).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

describe("api.key.rotate handler — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath("Owner");
  });

  it("returns the new key, raw key, and the revoked old key id", async () => {
    const out = await apiKeyRotateHandler(BASE_INPUT, TEST_CTX);
    expect(out.publicId).toBe("aky_new456");
    expect(out.revokedKeyPublicId).toBe("aky_old123");
    expect(out.rawKey).toMatch(/^ox_/);
    expect(out.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("inherits the old name when no override is given", async () => {
    const valuesSpy = vi.fn();
    vi.clearAllMocks();
    setupHappyPath("Owner", OLD_ROW, NEW_ROW, valuesSpy);
    await apiKeyRotateHandler(BASE_INPUT, TEST_CTX);
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "CI deploy key",
        workspaceId: "wrk_1",
        scope: { env: "prod" },
      }),
    );
  });

  it("uses the override name when provided", async () => {
    const valuesSpy = vi.fn();
    vi.clearAllMocks();
    setupHappyPath("Owner", OLD_ROW, NEW_ROW, valuesSpy);
    await apiKeyRotateHandler(
      { keyPublicId: "aky_old123", name: "Renamed key" },
      TEST_CTX,
    );
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed key" }),
    );
  });

  it("emits api_key.created and api_key.revoked", async () => {
    await apiKeyRotateHandler(BASE_INPUT, TEST_CTX);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(2);
    const types = mocks.emitSecurityEvent.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(types).toContain("api_key.created");
    expect(types).toContain("api_key.revoked");
  });

  it("performs the rotate in a single transaction (besides role resolution)", async () => {
    await apiKeyRotateHandler(BASE_INPUT, TEST_CTX);
    // call 1 = role resolution, call 2 = atomic select+insert+update
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it("works for an Admin actor and for machine (apiKeyId) auth", async () => {
    vi.clearAllMocks();
    setupHappyPath("Admin");
    const machine = makeCTX({ userId: null, apiKeyId: "aky_machine" });
    const out = await apiKeyRotateHandler(BASE_INPUT, machine);
    expect(out.revokedKeyPublicId).toBe("aky_old123");
  });
});
