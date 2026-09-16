/**
 * Unit tests for api.key.rotate handler.
 *
 * Coverage:
 *   - auth + scope guards (no principal / no org) → CapabilityError authz_denied
 *   - role gate (Member) → CapabilityError authz_denied
 *   - old key not found / already revoked → HandlerError(not_found)
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
import { type CapabilityContext, isHandlerError } from "@oxagen/oxagen";
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
  /** `deleted_at`. The handler's where filters it null, and it selects it so
   * the rotatability predicate sees the whole row. */
  revokedAt: Date | null;
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

/** The workspace the replacement would be minted into; null stands for one this org does not hold. */
type WorkspaceRow = { name: string; archivedAt: Date | null } | null;

const LIVE_WORKSPACE: WorkspaceRow = {
  name: "Core platform",
  archivedAt: null,
};

function makeRotateTx(
  oldRow: OldRow | null,
  newRow: NewRow,
  valuesSpy = vi.fn(),
  insertSpy = vi.fn(),
  updateSpy = vi.fn(),
  workspace: WorkspaceRow = LIVE_WORKSPACE,
) {
  // Two selects, in the order the handler makes them: the key being rotated,
  // then the workspace its replacement would be minted into. Only the second
  // takes a row lock; `lock` records the mode it asked for, so a test can hold
  // the guard to its mechanism and not only its answer.
  const lock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(workspace ? [workspace] : []));
  let selects = 0;
  return {
    lock,
    select: () => {
      selects++;
      const first = selects === 1;
      const rows = first ? (oldRow ? [oldRow] : []) : [];
      return {
        from: () => ({
          where: () => ({
            limit: () => (first ? Promise.resolve(rows) : { for: lock }),
          }),
        }),
      };
    },
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
  // Well clear of any clock this suite runs on: the handler now refuses to
  // rotate an expired key, so a near-future fixture would start failing.
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  revokedAt: null,
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
  it("refuses an old key that does not exist or is revoked as not_found", async () => {
    vi.clearAllMocks();
    setupHappyPath("Owner", null);
    await expect(apiKeyRotateHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "not_found" &&
        e.reason === "api_key_not_found",
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

describe("api.key.rotate handler — a key that has expired", () => {
  it("refuses before generating, inserting or revoking, because the replacement would carry the expiry that ended it", async () => {
    // deleted_at is null, so the not-found guard does not catch it. A page left
    // open across the expiry keeps offering Rotate; this refusal is what makes
    // clicking it harmless, and it is the same guarantee on api and mcp.
    const insertSpy = vi.fn();
    const updateSpy = vi.fn();
    const expiredRow: OldRow = {
      ...OLD_ROW,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    };
    vi.clearAllMocks();
    setupHappyPath("Owner", expiredRow, NEW_ROW, vi.fn(), insertSpy, updateSpy);

    await expect(apiKeyRotateHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "conflict" &&
        e.reason === "api_key_expired",
    );
    expect(mocks.generateApiKey).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses a row that arrives already revoked, the third reason the predicate weighs", async () => {
    // The where clause filters `deleted_at IS NULL`, so this cannot normally
    // arrive — the predicate covers it so `list_api_keys`, which does return
    // revoked rows, gets the same answer from the same function.
    const insertSpy = vi.fn();
    const updateSpy = vi.fn();
    vi.clearAllMocks();
    setupHappyPath(
      "Owner",
      { ...OLD_ROW, revokedAt: new Date("2026-09-10T08:00:00Z") },
      NEW_ROW,
      vi.fn(),
      insertSpy,
      updateSpy,
    );
    await expect(apiKeyRotateHandler(BASE_INPUT, TEST_CTX)).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "not_found" &&
        e.reason === "api_key_not_found",
    );
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rotates a key whose expiry is still ahead", async () => {
    vi.clearAllMocks();
    setupHappyPath("Owner", {
      ...OLD_ROW,
      expiresAt: new Date("2099-06-01T00:00:00Z"),
    });
    await expect(
      apiKeyRotateHandler(BASE_INPUT, TEST_CTX),
    ).resolves.toMatchObject({ publicId: "aky_new456" });
  });
});

describe("api.key.rotate handler — protected CLI session scope", () => {
  it("refuses to rotate a CLI session key: `oxagen login` mints its replacement", async () => {
    const insertSpy = vi.fn();
    const updateSpy = vi.fn();
    const protectedRow: OldRow = {
      ...OLD_ROW,
      scope: { purpose: "cli_session_v1" },
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

describe("api.key.rotate handler — protected agent credential scope", () => {
  it("refuses to rotate an agent credential: rotate_agent_credential owns that key", async () => {
    const insertSpy = vi.fn();
    const updateSpy = vi.fn();
    const protectedRow: OldRow = {
      ...OLD_ROW,
      scope: {
        purpose: "agent_credential_v1",
        agent_id: "agt_0123456789abcdefghjkmn",
        principal_id: "prn_0123456789abcdefghjkmn",
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

describe("api.key.rotate handler — archived workspace", () => {
  // What archival should prevent is fresh secret material being issued for a
  // workspace meant to be inert, and a rotation mints a new key with a new
  // secret whatever its expiry. `create_api_key` refuses the same way; the two
  // are uniform so the rule reads in one sentence.
  //
  // This does not close the access hole: the key being rotated still
  // authenticates into the archived workspace (#3123). Revoke is the path that
  // helps there, and it carries no archival check.
  function setupArchived(
    workspace: WorkspaceRow,
    spies: {
      valuesSpy: ReturnType<typeof vi.fn>;
      insertSpy: ReturnType<typeof vi.fn>;
      updateSpy: ReturnType<typeof vi.fn>;
    },
  ) {
    let call = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => {
        call++;
        if (call === 1) return fn(makeRoleResolutionTx("principal-1", "Owner"));
        return fn(
          makeRotateTx(
            OLD_ROW,
            NEW_ROW,
            spies.valuesSpy,
            spies.insertSpy,
            spies.updateSpy,
            workspace,
          ),
        );
      },
    );
  }

  it("refuses to rotate a key in an archived workspace, minting and revoking nothing (negative)", async () => {
    const spies = {
      valuesSpy: vi.fn(),
      insertSpy: vi.fn(),
      updateSpy: vi.fn(),
    };
    setupArchived(
      { name: "Sunset", archivedAt: new Date("2026-09-01T00:00:00.000Z") },
      spies,
    );
    mocks.emitSecurityEvent.mockClear();

    await expect(apiKeyRotateHandler(BASE_INPUT, makeCTX())).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "conflict" &&
        e.reason === "workspace_archived",
    );
    // The old key is untouched — refusing must not leave the caller with
    // neither credential, which is the whole hazard of this capability.
    expect(spies.insertSpy).not.toHaveBeenCalled();
    expect(spies.updateSpy).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    expect(mocks.generateApiKey).not.toHaveBeenCalled();
  });

  it("refuses a workspace this org does not hold, minting and revoking nothing (negative)", async () => {
    const spies = {
      valuesSpy: vi.fn(),
      insertSpy: vi.fn(),
      updateSpy: vi.fn(),
    };
    setupArchived(null, spies);

    await expect(apiKeyRotateHandler(BASE_INPUT, makeCTX())).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "not_found" &&
        e.reason === "workspace_not_found",
    );
    expect(spies.insertSpy).not.toHaveBeenCalled();
    expect(spies.updateSpy).not.toHaveBeenCalled();
  });

  it("takes a row lock on the workspace, which is what makes the check hold", async () => {
    // The guard's correctness is not "the check is inside the transaction" —
    // that only makes the statements atomic with respect to failure. Under
    // READ COMMITTED an unlocked SELECT snapshots at statement start and
    // `archive_workspace` can commit before the write, so the check would pass
    // on precisely the interleaving its comment claims to prevent.
    //
    // The lock is the mechanism, so it is what the test pins: a future reader
    // deleting `.for("update")` as redundant fails here rather than silently
    // reopening the race.
    const spies = {
      valuesSpy: vi.fn(),
      insertSpy: vi.fn(),
      updateSpy: vi.fn(),
    };
    const tx = makeRotateTx(
      OLD_ROW,
      NEW_ROW,
      spies.valuesSpy,
      spies.insertSpy,
      spies.updateSpy,
      LIVE_WORKSPACE,
    );
    let call = 0;
    mocks.withTenantDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => {
        call++;
        if (call === 1) return fn(makeRoleResolutionTx("principal-1", "Owner"));
        return fn(tx);
      },
    );

    await apiKeyRotateHandler(BASE_INPUT, makeCTX());
    expect(tx.lock).toHaveBeenCalledWith("update");
  });

  it("rotates in a workspace still in use, as before", async () => {
    setupHappyPath("Owner");
    const out = await apiKeyRotateHandler(BASE_INPUT, makeCTX());
    expect(out.rawKey).toBe("ox_rotated_secret");
  });
});
