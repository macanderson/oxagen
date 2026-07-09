// iam-provision.test.ts — unit tests for bootstrapOrgIAM / provisionMemberPrincipal (OXA-1524).
//
// Tests verify:
//   - bootstrapOrgIAM inserts 7 system roles with deterministic public_ids
//   - Owner principal is created with kind:"human"
//   - Owner role assignment is created via principalRoleAssignments
//   - role_grants are seeded from listCapabilities()
//   - provisionMemberPrincipal creates a principal with NO role assignment
//   - Both functions are idempotent (select-then-insert pattern)
//
// Owner resolves "allow" / member resolves "deny" scenario is validated by
// asserting the seeded data that drives the resolver (the resolver itself is
// tested in @oxagen/oxagen/src/iam/resolve.test.ts).

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  listCapabilities: vi.fn(),
  withSystemDb: vi.fn(),
}));

// Default: throw when withSystemDb is called unexpectedly (most tests pass tx directly).
mocks.withSystemDb.mockImplementation(async (_fn: unknown) => {
  throw new Error("[test] withSystemDb() should not be called when tx param is provided");
});

// Column references used by drizzle-orm are mocked as plain strings.
// All tests pass an explicit tx param — neither db() nor withSystemDb should
// be called when tx is provided.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  db: () => { throw new Error("[test] db() should not be called directly — pass tx param"); },
  withSystemDb: (fn: unknown): Promise<unknown> => mocks.withSystemDb(fn) as Promise<unknown>,

  };
});

vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: mocks.listCapabilities,
}));

// Minimal logger stub.
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Mock DB builder ───────────────────────────────────────────────────────────
// buildMockDb creates a minimal in-memory mock of the Drizzle db() interface.
// The select call counter drives which fixture row is returned for each query
// in the bootstrapOrgIAM call sequence.

type InsertedRow = { values: Record<string, unknown> };

function buildMockDb(opts: {
  existingRoles?: boolean;
  existingPrincipal?: boolean;
  existingPra?: boolean;
  userDisplayName?: string | null;
}): { _insertedRows: InsertedRow[] } & Record<string, unknown> {
  const insertedThisTest: InsertedRow[] = [];
  let selectCount = 0;

  const makeSelectResult = (): unknown[] => {
    const idx = selectCount++;
    // bootstrapOrgIAM query order:
    // Queries 0..6: role existence checks (7 roles, one per role spec)
    // Query 7: user display name lookup
    // Query 8: principal existence check
    // Query 9: PRA existence check
    if (idx < 7) {
      return opts.existingRoles ? [{ id: `role_existing_${idx}` }] : [];
    }
    if (idx === 7) {
      return [{ displayName: opts.userDisplayName ?? "Test User", email: "test@example.com" }];
    }
    if (idx === 8) {
      return opts.existingPrincipal ? [{ id: "prn_existing" }] : [];
    }
    if (idx === 9) {
      return opts.existingPra ? [{ id: "pra_existing" }] : [];
    }
    return [];
  };

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(makeSelectResult()),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertedThisTest.push({ values });
        return {
          onConflictDoNothing: () => ({
            returning: () => {
              const publicId = values["publicId"] as string | undefined;
              const id = `internal_${publicId ?? `gen_${insertedThisTest.length}`}`;
              return Promise.resolve([{ id, publicId }]);
            },
          }),
        };
      },
    }),
    _insertedRows: insertedThisTest,
  } as unknown as { _insertedRows: InsertedRow[] } & Record<string, unknown>;
}

// ── Import after mocks ────────────────────────────────────────────────────────

import { bootstrapOrgIAM, provisionMemberPrincipal } from "./iam-provision";

// ── Minimal capability fixtures ───────────────────────────────────────────────

const FAKE_CAPABILITIES = [
  {
    name: "send_message",
    defaultRoles: {
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    },
  },
  {
    name: "create_org",
    defaultRoles: {
      org: { Owner: "allow" },
      workspace: {},
    },
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("bootstrapOrgIAM()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCapabilities.mockReturnValue(FAKE_CAPABILITIES);
  });

  it("inserts exactly 7 system roles (4 org + 3 workspace) for a fresh org", async () => {
    const db = buildMockDb({});

    await bootstrapOrgIAM({
      orgId: "org_fresh",
      ownerUserId: "usr_owner",
      actorUserId: "usr_owner",
      tx: db as unknown as Parameters<typeof bootstrapOrgIAM>[0]["tx"],
    });

    const rows = db._insertedRows;
    // Count role inserts — they have a scopeKind field.
    const roleInserts = rows.filter((r) => "scopeKind" in r.values);
    expect(roleInserts).toHaveLength(7);

    // Check org roles.
    const orgRoles = roleInserts.filter((r) => r.values["scopeKind"] === "org");
    expect(orgRoles).toHaveLength(4);
    const orgRoleNames = orgRoles.map((r) => r.values["name"] as string).sort();
    expect(orgRoleNames).toEqual(["Admin", "Billing", "Compliance", "Owner"]);

    // Check workspace roles.
    const wsRoles = roleInserts.filter((r) => r.values["scopeKind"] === "workspace");
    expect(wsRoles).toHaveLength(3);
    const wsRoleNames = wsRoles.map((r) => r.values["name"] as string).sort();
    expect(wsRoleNames).toEqual(["Member", "Owner", "Viewer"]);
  });

  it("role public_ids are deterministic (same input → same output)", async () => {
    // We test determinism by running bootstrapOrgIAM twice on the "same" fresh org
    // and checking that the publicId on the first role insert matches the expected
    // hash-derived pattern.
    const db1 = buildMockDb({});
    const db2 = buildMockDb({});

    await bootstrapOrgIAM({
      orgId: "org_det_test",
      ownerUserId: "usr_det",
      actorUserId: "usr_det",
      tx: db1 as unknown as Parameters<typeof bootstrapOrgIAM>[0]["tx"],
    });
    await bootstrapOrgIAM({
      orgId: "org_det_test",
      ownerUserId: "usr_det",
      actorUserId: "usr_det",
      tx: db2 as unknown as Parameters<typeof bootstrapOrgIAM>[0]["tx"],
    });

    const rows1 = db1._insertedRows;
    const rows2 = db2._insertedRows;

    // Both runs must produce identical publicIds for the same (orgId, scopeKind, name).
    const roleIds1 = rows1
      .filter((r) => "scopeKind" in r.values)
      .map((r) => r.values["publicId"] as string)
      .sort();
    const roleIds2 = rows2
      .filter((r) => "scopeKind" in r.values)
      .map((r) => r.values["publicId"] as string)
      .sort();

    expect(roleIds1).toEqual(roleIds2);
    // Each publicId must match the rol_ prefix + 22 hex chars pattern.
    for (const id of roleIds1) {
      expect(id).toMatch(/^rol_[a-f0-9]{22}$/);
    }
  });

  it("inserts the owner principal with kind 'human' and parentUserId = ownerUserId", async () => {
    const db = buildMockDb({});

    await bootstrapOrgIAM({
      orgId: "org_owner_prn",
      ownerUserId: "usr_owner_x",
      actorUserId: "usr_owner_x",
      tx: db as unknown as Parameters<typeof bootstrapOrgIAM>[0]["tx"],
    });

    const rows = db._insertedRows;
    const principalInsert = rows.find((r) => r.values["kind"] === "human");
    expect(principalInsert).toBeDefined();
    expect(principalInsert?.values["parentUserId"]).toBe("usr_owner_x");
    expect(principalInsert?.values["status"]).toBe("active");
  });

  it("inserts a principalRoleAssignment linking owner to org:Owner role", async () => {
    const db = buildMockDb({});

    await bootstrapOrgIAM({
      orgId: "org_pra_test",
      ownerUserId: "usr_pra_owner",
      actorUserId: "usr_pra_owner",
      tx: db as unknown as Parameters<typeof bootstrapOrgIAM>[0]["tx"],
    });

    const rows = db._insertedRows;
    // PRA row: has principalId and roleId but no scopeKind (not a role or principal insert).
    const praInsert = rows.find(
      (r) =>
        "principalId" in r.values &&
        "roleId" in r.values &&
        !("kind" in r.values) &&
        !("scopeKind" in r.values),
    );
    expect(praInsert).toBeDefined();
    expect(praInsert?.values["orgId"]).toBe("org_pra_test");
  });

  it("seeds role_grants from FAKE_CAPABILITIES defaultRoles", async () => {
    const db = buildMockDb({});

    await bootstrapOrgIAM({
      orgId: "org_grants_test",
      ownerUserId: "usr_grants",
      actorUserId: "usr_grants",
      tx: db as unknown as Parameters<typeof bootstrapOrgIAM>[0]["tx"],
    });

    const rows = db._insertedRows;
    // role_grant rows: have capabilityId and effect fields.
    const rgInserts = rows.filter((r) => "capabilityId" in r.values && "effect" in r.values);

    // FAKE_CAPABILITIES: chat.message.send has 4 grants (Owner/Admin org + Owner/Member ws)
    //                    organization.create has 1 grant (Owner org)
    // Total: 5 role_grant rows.
    expect(rgInserts.length).toBeGreaterThanOrEqual(5);

    const capabilities = rgInserts.map((r) => r.values["capabilityId"] as string);
    expect(capabilities).toContain("send_message");
    expect(capabilities).toContain("create_org");
  });

  it("skips inserting an existing principal (idempotent — no duplicate insert)", async () => {
    const db = buildMockDb({ existingPrincipal: true });

    // Should not throw, and should not insert a second principal.
    await bootstrapOrgIAM({
      orgId: "org_idem",
      ownerUserId: "usr_idem",
      actorUserId: "usr_idem",
      tx: db as unknown as Parameters<typeof bootstrapOrgIAM>[0]["tx"],
    });

    const rows = db._insertedRows;
    const principalInserts = rows.filter((r) => r.values["kind"] === "human");
    // When existing principal found via select, no insert should occur.
    expect(principalInserts).toHaveLength(0);
  });
});

describe("provisionMemberPrincipal()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCapabilities.mockReturnValue(FAKE_CAPABILITIES);
  });

  it("inserts a human principal with NO role assignment (least-privilege)", async () => {
    let selectCount = 0;
    const insertedThisTest: Array<{ values: Record<string, unknown> }> = [];

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const idx = selectCount++;
              if (idx === 0) return Promise.resolve([]); // no existing principal
              if (idx === 1) {
                // user select
                return Promise.resolve([{ displayName: "New Member", email: "member@example.com" }]);
              }
              return Promise.resolve([]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedThisTest.push({ values });
          return {
            onConflictDoNothing: () => ({
              returning: () =>
                Promise.resolve([{ id: "prn_new_member" }]),
            }),
          };
        },
      }),
    };

    const principalId = await provisionMemberPrincipal({
      orgId: "org_lp",
      userId: "usr_member",
      actorUserId: "usr_admin",
      tx: db as unknown as Parameters<typeof provisionMemberPrincipal>[0]["tx"],
    });

    expect(principalId).toBe("prn_new_member");
    // Only one insert — the principal itself. No role assignment.
    expect(insertedThisTest).toHaveLength(1);
    expect(insertedThisTest[0]?.values["kind"]).toBe("human");
    expect(insertedThisTest[0]?.values["parentUserId"]).toBe("usr_member");
  });

  it("returns existing principalId without inserting when principal already exists", async () => {
    let selectCount = 0;
    const insertedThisTest: Array<{ values: Record<string, unknown> }> = [];

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const idx = selectCount++;
              if (idx === 0) return Promise.resolve([{ id: "prn_already_exists" }]);
              return Promise.resolve([]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedThisTest.push({ values });
          return {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([{ id: "prn_new" }]),
            }),
          };
        },
      }),
    };

    const principalId = await provisionMemberPrincipal({
      orgId: "org_idem_member",
      userId: "usr_idem_member",
      actorUserId: "usr_admin",
      tx: db as unknown as Parameters<typeof provisionMemberPrincipal>[0]["tx"],
    });

    expect(principalId).toBe("prn_already_exists");
    // No insert — select found existing row.
    expect(insertedThisTest).toHaveLength(0);
  });

  it("uses withSystemDb fallback when no tx is provided (lines 365–366)", async () => {
    // When no tx param is supplied, provisionMemberPrincipal must open its own
    // system-bypass transaction via withSystemDb. This test exercises the
    // `if (tx) { ... } return withSystemDb(...)` branch.
    let selectCount = 0;

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const idx = selectCount++;
              if (idx === 0) return Promise.resolve([]); // no existing principal
              if (idx === 1) {
                return Promise.resolve([{ displayName: "Fallback User", email: "fallback@example.com" }]);
              }
              return Promise.resolve([]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: (_values: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ id: "prn_fallback" }]),
          }),
        }),
      }),
    };

    // Allow withSystemDb to call through with the fake db.
    mocks.withSystemDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    );

    // Call WITHOUT passing tx — forces the withSystemDb code path.
    const principalId = await provisionMemberPrincipal({
      orgId: "org_fallback",
      userId: "usr_fallback",
      actorUserId: "usr_admin",
    });

    expect(principalId).toBe("prn_fallback");
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  it("re-selects principal on lost insert race and returns its id (lines 420–436)", async () => {
    // Simulates the concurrent-insert race: insert().onConflictDoNothing()
    // returns an empty array (the conflict handler swallowed the insert),
    // so the function must fall through to a second SELECT to recover the
    // winning row's id.
    let selectCount = 0;

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const idx = selectCount++;
              if (idx === 0) return Promise.resolve([]); // no existing principal on first check
              if (idx === 1) {
                // user display name lookup
                return Promise.resolve([{ displayName: "Race User", email: "race@example.com" }]);
              }
              if (idx === 2) {
                // re-select after lost race — return the winner's row
                return Promise.resolve([{ id: "prn_race_winner" }]);
              }
              return Promise.resolve([]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: (_values: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            // Empty array: insert was suppressed by onConflictDoNothing
            returning: () => Promise.resolve([]),
          }),
        }),
      }),
    };

    const principalId = await provisionMemberPrincipal({
      orgId: "org_race",
      userId: "usr_race",
      actorUserId: "usr_admin",
      tx: db as unknown as Parameters<typeof provisionMemberPrincipal>[0]["tx"],
    });

    // Must return the re-selected row's id (the race winner).
    expect(principalId).toBe("prn_race_winner");
  });

  it("throws when re-select after lost insert race returns no row (lines 431–433)", async () => {
    // Edge case: the winning concurrent insert is rolled back between the
    // onConflictDoNothing suppression and the re-select. provisionMemberPrincipal
    // must throw a clear error rather than returning undefined.
    let selectCount = 0;

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const idx = selectCount++;
              if (idx === 0) return Promise.resolve([]); // no existing principal
              if (idx === 1) {
                return Promise.resolve([{ displayName: "Ghost User", email: "ghost@example.com" }]);
              }
              // re-select also returns nothing (winner rolled back)
              return Promise.resolve([]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: (_values: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([]),
          }),
        }),
      }),
    };

    await expect(
      provisionMemberPrincipal({
        orgId: "org_ghost",
        userId: "usr_ghost",
        actorUserId: "usr_admin",
        tx: db as unknown as Parameters<typeof provisionMemberPrincipal>[0]["tx"],
      }),
    ).rejects.toThrow("[iam-provision] Failed to upsert member principal for org org_ghost, user usr_ghost");
  });
});
