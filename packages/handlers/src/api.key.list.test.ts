/**
 * Unit tests for the list_api_keys handler.
 *
 * Guards and their negatives:
 *   - no authenticated principal → CapabilityError authz_denied
 *   - missing orgId / missing workspaceId → CapabilityError authz_denied
 *   - no principal row, Member, Viewer → CapabilityError authz_denied, no read
 *   - Owner and Admin → the rows in scope, newest first, revoked ones included
 *   - the projection never selects key_hash, and the output carries no field
 *     named like a secret, a hash or a key
 *   - apiKeyId as the actor (machine-to-machine) → succeeds
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { apiKeyListHandler } from "./api.key.list";
import type { CapabilityContext } from "@oxagen/oxagen";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── stored rows ───────────────────────────────────────────────────────────────

type StoredKey = {
  publicId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
};

const LIVE: StoredKey = {
  publicId: "aky_live",
  name: "ci runner",
  keyPrefix: "ox_liveliveli",
  keyHash: "sha256-of-the-live-key",
  createdAt: new Date("2026-09-13T10:00:00.000Z"),
  lastUsedAt: new Date("2026-09-13T11:30:00.000Z"),
  expiresAt: null,
  deletedAt: null,
};

const REVOKED: StoredKey = {
  publicId: "aky_old",
  name: "laptop",
  keyPrefix: "ox_oldoldoldo",
  keyHash: "sha256-of-the-old-key",
  createdAt: new Date("2026-09-01T09:00:00.000Z"),
  lastUsedAt: null,
  expiresAt: new Date("2026-12-31T00:00:00.000Z"),
  deletedAt: new Date("2026-09-10T08:00:00.000Z"),
};

// ── tx doubles ────────────────────────────────────────────────────────────────

/** The two selects resolveActorOrgRole runs: principal, then role. */
function makeRoleResolutionTx(
  principalId: string | null,
  roleName: string | null,
) {
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi
                .fn()
                .mockResolvedValue(principalId ? [{ id: principalId }] : []),
            }),
          }),
        };
      }
      return {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(roleName ? [{ roleName }] : []),
            }),
          }),
        }),
      };
    }),
  };
}

/**
 * The list select. Applies the handler's projection to the stored rows the
 * way Drizzle would (each selected column maps to the stored column), so the
 * test proves which columns the handler asked for, and captures the
 * projection so a test can assert key_hash is not among them.
 */
function makeListTx(stored: StoredKey[], seen: { projection?: object }) {
  return {
    select: vi
      .fn()
      .mockImplementation((projection: Record<string, unknown>) => {
        seen.projection = projection;
        const columnNames = Object.fromEntries(
          Object.entries(projection).map(([out, col]) => [
            out,
            Object.entries(schema.apiKeys).find(([, c]) => c === col)?.[0],
          ]),
        );
        const rows = stored.map((row) =>
          Object.fromEntries(
            Object.entries(columnNames).map(([out, stored]) => [
              out,
              row[stored as keyof StoredKey],
            ]),
          ),
        );
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(rows),
            }),
          }),
        };
      }),
  };
}

function setup(
  roleName: string | null,
  stored: StoredKey[] = [LIVE, REVOKED],
  principalId: string | null = "principal-uuid-1",
) {
  const seen: { projection?: object } = {};
  let callCount = 0;
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => {
      callCount++;
      if (callCount === 1)
        return fn(makeRoleResolutionTx(principalId, roleName));
      return fn(makeListTx(stored, seen));
    },
  );
  return seen;
}

const denied = (e: unknown) =>
  e instanceof CapabilityError &&
  e.code === "authz_denied" &&
  e.capability === "list_api_keys";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("list_api_keys — auth + scope guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup("Owner");
  });

  it("refuses a caller with neither userId nor apiKeyId", async () => {
    const anonCtx: CapabilityContext = makeCTX({
      userId: null,
      apiKeyId: null,
    });
    await expect(apiKeyListHandler({}, anonCtx)).rejects.toSatisfy(denied);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("refuses a context with no orgId", async () => {
    const noOrgCtx = {
      ...TEST_CTX,
      orgId: null,
    } as unknown as CapabilityContext;
    await expect(apiKeyListHandler({}, noOrgCtx)).rejects.toSatisfy(denied);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("refuses a context with no workspaceId", async () => {
    // workspaceId is a string in CapabilityContext; forced null to exercise the guard.
    const noWsCtx = {
      ...TEST_CTX,
      workspaceId: null,
    } as unknown as CapabilityContext;
    await expect(apiKeyListHandler({}, noWsCtx)).rejects.toSatisfy(denied);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});

describe("list_api_keys — role gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses an actor with no principal row and never reads the keys", async () => {
    setup(null, [LIVE], null);
    await expect(apiKeyListHandler({}, TEST_CTX)).rejects.toSatisfy(denied);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });

  it.each(["Member", "Viewer", "Billing", "Compliance"])(
    "refuses an actor whose org role is %s and never reads the keys",
    async (role) => {
      setup(role);
      await expect(apiKeyListHandler({}, TEST_CTX)).rejects.toSatisfy(denied);
      expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    },
  );
});

describe("list_api_keys — read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns every key in scope for an Owner, revoked ones included, with ISO timestamps", async () => {
    setup("Owner");
    const result = await apiKeyListHandler({}, TEST_CTX);
    expect(result).toEqual({
      items: [
        {
          publicId: "aky_live",
          name: "ci runner",
          prefix: "ox_liveliveli",
          createdAt: "2026-09-13T10:00:00.000Z",
          lastUsedAt: "2026-09-13T11:30:00.000Z",
          expiresAt: null,
          revokedAt: null,
        },
        {
          publicId: "aky_old",
          name: "laptop",
          prefix: "ox_oldoldoldo",
          createdAt: "2026-09-01T09:00:00.000Z",
          lastUsedAt: null,
          expiresAt: "2026-12-31T00:00:00.000Z",
          revokedAt: "2026-09-10T08:00:00.000Z",
        },
      ],
    });
  });

  it("returns the same shape for an Admin", async () => {
    setup("Admin", [LIVE]);
    const result = await apiKeyListHandler({}, TEST_CTX);
    expect(result.items.map((i) => i.publicId)).toEqual(["aky_live"]);
  });

  it("returns an empty list when the scope holds no keys", async () => {
    setup("Owner", []);
    await expect(apiKeyListHandler({}, TEST_CTX)).resolves.toEqual({
      items: [],
    });
  });

  it("never selects key_hash and its output parses under the contract with no secret-shaped field", async () => {
    const seen = setup("Owner");
    const result = await apiKeyListHandler({}, TEST_CTX);

    const selected = Object.values(seen.projection ?? {});
    expect(selected).not.toContain(schema.apiKeys.keyHash);
    expect(selected).toContain(schema.apiKeys.keyPrefix);

    const parsed = apiKeyList.output.parse(result);
    for (const item of parsed.items) {
      expect(
        Object.keys(item).filter((k) => /secret|hash|key$/i.test(k)),
      ).toEqual([]);
      expect(JSON.stringify(item)).not.toContain("sha256-of-the");
    }
  });

  it("succeeds with apiKeyId as the actor (machine-to-machine)", async () => {
    setup("Admin", [LIVE]);
    const machineCtx = makeCTX({ userId: null, apiKeyId: "aky_machine" });
    const result = await apiKeyListHandler({}, machineCtx);
    expect(result.items).toHaveLength(1);
  });
});
