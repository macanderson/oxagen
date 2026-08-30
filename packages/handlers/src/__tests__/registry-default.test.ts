/**
 * TDD: single-default registry state machine
 *
 * Every transition of the addRegistry / removeRegistry helpers:
 *
 *   add-to-empty        → new row is_default=true
 *   add-to-nonempty     → new row is_default=false
 *   remove-non-default  → row deleted, no promotion
 *   remove-default-with-others → row deleted + most-recently-created remaining row promoted
 *   remove-default-alone       → row deleted, no promotion (no remaining rows)
 *   exactly-1-is-default       → the lone registry is always the default (invariant)
 *
 * Uses vi.mock on @oxagen/database matching the pattern in
 * __tests__/workspace-registry-seed.test.ts — a hoisted mock that returns a
 * minimal Tx stub whose methods are vi.fn() so we can assert call args.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
//
// The implementation calls tx.select() twice:
//   1. count query:  select({ count: sql`count(*)` }).from(...).where(...)       → resolves []
//   2. find-remaining: select({ id: ... }).from(...).where(...).orderBy(...).limit(1)
//
// We use a call-count router on tx.select so the first call returns the count chain
// and the second returns the find-remaining chain.
//
const mocks = vi.hoisted(() => ({
  // insert().values().returning() chain
  insertValuesReturning: vi.fn(),
  insertValues: vi.fn(),
  insert: vi.fn(),

  // delete().where().returning() chain
  deleteWhereReturning: vi.fn(),
  deleteWhere: vi.fn(),
  delete: vi.fn(),

  // update().set().where() chain (promotion)
  updateSetWhere: vi.fn(),
  updateSet: vi.fn(),
  update: vi.fn(),

  // Count query select chain result (resolves to [{ count: "0" }])
  countResult: vi.fn(),

  // Find-remaining select chain result (resolves to [])
  findResult: vi.fn(),
}));

// Wired defaults — restored in beforeEach
mocks.updateSetWhere.mockResolvedValue(undefined);
mocks.updateSet.mockReturnValue({ where: mocks.updateSetWhere });
mocks.update.mockReturnValue({ set: mocks.updateSet });

mocks.insertValuesReturning.mockResolvedValue([{ id: "mreg_new" }]);
mocks.insertValues.mockReturnValue({ returning: mocks.insertValuesReturning });
mocks.insert.mockReturnValue({ values: mocks.insertValues });

mocks.deleteWhereReturning.mockResolvedValue([
  { id: "mreg_del", isDefault: false },
]);
mocks.deleteWhere.mockReturnValue({ returning: mocks.deleteWhereReturning });
mocks.delete.mockReturnValue({ where: mocks.deleteWhere });

mocks.countResult.mockResolvedValue([{ count: "0" }]);
mocks.findResult.mockResolvedValue([]);

/**
 * Build a tx stub.  Drizzle select() is called with different column shapes:
 *   - count query:        { count: sql`count(*)` }  → has "count" key
 *   - find-remaining:     { id: col }               → has "id" key, supports orderBy+limit
 *
 * We inspect the first key of the columns arg to route to the right mock chain.
 */
function makeTx() {
  return {
    select: (cols?: Record<string, unknown>) => {
      const isCount = cols != null && "count" in cols;
      if (isCount) {
        // Count query: .from().where() → resolves to [{ count }]
        return {
          from: () => ({
            where: () => mocks.countResult(),
          }),
        };
      }
      // Find-remaining query: .from().where().orderBy().limit() → resolves to rows
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => mocks.findResult(),
            }),
          }),
        }),
      };
    },
    insert: mocks.insert,
    delete: mocks.delete,
    update: mocks.update,
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeTx() as unknown as Tx),
    schema: real.schema,
  };
});

import type { Tx } from "@oxagen/database";
import { addRegistry, removeRegistry } from "../registry-default";

// ─────────────────────────────────────────────────────────────────────────────

const ORG = "org_1";
const WS = "ws_1";

function resetMocks() {
  mocks.insert.mockClear();
  mocks.insertValues.mockClear();
  mocks.insertValuesReturning.mockClear();
  mocks.delete.mockClear();
  mocks.deleteWhere.mockClear();
  mocks.deleteWhereReturning.mockClear();
  mocks.update.mockClear();
  mocks.updateSet.mockClear();
  mocks.updateSetWhere.mockClear();
  mocks.countResult.mockClear();
  mocks.findResult.mockClear();

  // Restore defaults
  mocks.updateSetWhere.mockResolvedValue(undefined);
  mocks.updateSet.mockReturnValue({ where: mocks.updateSetWhere });
  mocks.update.mockReturnValue({ set: mocks.updateSet });

  mocks.insertValuesReturning.mockResolvedValue([{ id: "mreg_new" }]);
  mocks.insertValues.mockReturnValue({
    returning: mocks.insertValuesReturning,
  });
  mocks.insert.mockReturnValue({ values: mocks.insertValues });

  mocks.deleteWhereReturning.mockResolvedValue([
    { id: "mreg_del", isDefault: false },
  ]);
  mocks.deleteWhere.mockReturnValue({ returning: mocks.deleteWhereReturning });
  mocks.delete.mockReturnValue({ where: mocks.deleteWhere });

  mocks.countResult.mockResolvedValue([{ count: "0" }]);
  mocks.findResult.mockResolvedValue([]);
}

// ── addRegistry ───────────────────────────────────────────────────────────────

describe("addRegistry", () => {
  beforeEach(resetMocks);

  it("add-to-empty: isDefault=true when no registries exist for (org, ws)", async () => {
    // count query returns 0 (default)
    const tx = makeTx() as unknown as Tx;
    const result = await addRegistry(tx, {
      orgId: ORG,
      workspaceId: WS,
      name: "My Registry",
      baseUrl: "https://example.com",
    });

    expect(result.isDefault).toBe(true);
    expect(result.id).toBe("mreg_new");
    // insert should have been called once
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it("add-to-nonempty: isDefault=false when ≥1 registry already exists", async () => {
    // count query returns 2
    mocks.countResult.mockResolvedValue([{ count: "2" }]);

    const tx = makeTx() as unknown as Tx;
    const result = await addRegistry(tx, {
      orgId: ORG,
      workspaceId: WS,
      name: "Second Registry",
      baseUrl: "https://second.com",
    });

    expect(result.isDefault).toBe(false);
    expect(result.id).toBe("mreg_new");
  });

  it("returns the id from the inserted row", async () => {
    mocks.insertValuesReturning.mockResolvedValue([{ id: "mreg_custom_id" }]);

    const tx = makeTx() as unknown as Tx;
    const result = await addRegistry(tx, {
      orgId: ORG,
      workspaceId: WS,
      name: "Test",
      baseUrl: "https://test.example",
    });

    expect(result.id).toBe("mreg_custom_id");
  });

  it("throws when insert returns no row", async () => {
    mocks.insertValuesReturning.mockResolvedValue([]);

    const tx = makeTx() as unknown as Tx;
    await expect(
      addRegistry(tx, {
        orgId: ORG,
        workspaceId: WS,
        name: "Test",
        baseUrl: "https://t.com",
      }),
    ).rejects.toThrow("registry insert returned no row");
  });
});

// ── removeRegistry ────────────────────────────────────────────────────────────

describe("removeRegistry", () => {
  beforeEach(resetMocks);

  it("remove-non-default: deletes row, no promotion, promotedId=null", async () => {
    // deleted row is NOT the default
    mocks.deleteWhereReturning.mockResolvedValue([
      { id: "mreg_del", isDefault: false },
    ]);

    const tx = makeTx() as unknown as Tx;
    const result = await removeRegistry(tx, {
      orgId: ORG,
      workspaceId: WS,
      registryId: "mreg_del",
    });

    expect(result.removed).toBe(true);
    expect(result.promotedId).toBeNull();
    // No update (no promotion needed)
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("remove-default-alone: deletes default, no remaining rows → promotedId=null", async () => {
    // deleted row WAS the default
    mocks.deleteWhereReturning.mockResolvedValue([
      { id: "mreg_default", isDefault: true },
    ]);
    // No remaining registries (findResult default is [])

    const tx = makeTx() as unknown as Tx;
    const result = await removeRegistry(tx, {
      orgId: ORG,
      workspaceId: WS,
      registryId: "mreg_default",
    });

    expect(result.removed).toBe(true);
    expect(result.promotedId).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("remove-default-with-others: deletes default + promotes most-recently-created remaining row", async () => {
    // deleted row WAS the default
    mocks.deleteWhereReturning.mockResolvedValue([
      { id: "mreg_default", isDefault: true },
    ]);
    // One remaining row to promote
    mocks.findResult.mockResolvedValue([{ id: "mreg_most_recent" }]);

    const tx = makeTx() as unknown as Tx;
    const result = await removeRegistry(tx, {
      orgId: ORG,
      workspaceId: WS,
      registryId: "mreg_default",
    });

    expect(result.removed).toBe(true);
    expect(result.promotedId).toBe("mreg_most_recent");
    // update called once (to promote)
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("returns removed=false when no row matched (wrong org/ws/id)", async () => {
    mocks.deleteWhereReturning.mockResolvedValue([]);

    const tx = makeTx() as unknown as Tx;
    const result = await removeRegistry(tx, {
      orgId: ORG,
      workspaceId: WS,
      registryId: "mreg_nonexistent",
    });

    expect(result.removed).toBe(false);
    expect(result.promotedId).toBeNull();
  });

  it("invariant: exactly-1-is-default — with 1 registry it is always the default", async () => {
    // When we add to an empty workspace the result must be isDefault=true
    // countResult default is "0" — empty workspace
    mocks.insertValuesReturning.mockResolvedValue([{ id: "mreg_only" }]);

    const tx = makeTx() as unknown as Tx;
    const added = await addRegistry(tx, {
      orgId: ORG,
      workspaceId: WS,
      name: "Only Registry",
      baseUrl: "https://only.example",
    });

    expect(added.isDefault).toBe(true);
  });
});
