// `postgresRoleStore.activeAssignmentCount` — which transaction it asks, and
// what it fences on (#3110).
//
// `iam.principal_role_assignments` is `workspace_nullable`
// (packages/database/src/tenant-policy.manifest.ts): its `tenant_isolation`
// USING clause shows a row only when `workspace_id IS NULL` or it equals
// `app.current_workspace_id`. Asking the caller's own tenant transaction
// therefore answers "how many holders are visible from where I happen to be
// standing", not "how many holders are there" — and under the org-only
// sentinel (ADR-068), which names no workspace, the answer is every org-wide
// assignment and nothing else. `delete_role` acts on that number, so a role
// held only in a workspace read as held by nobody and was deleted, grants and
// all, out from under live assignment rows. RLS hides; it does not raise, so
// nothing surfaced.
//
// The fix is the one `list_iam_roles` already used: read through withSystemDb
// and write the org fence out by hand. These tests hold both halves — the read
// does not touch the caller's tx, and the org fence is in the SQL.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  /** Every `where(...)` predicate the system transaction was handed. */
  predicates: [] as unknown[],
  /** Set if anything reached the caller's tenant transaction. */
  usedCallerTx: false,
  count: 0,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const systemDb = {
    select: () => ({
      from: () => ({
        where: (predicate: unknown) => {
          calls.predicates.push(predicate);
          return Promise.resolve([{ count: calls.count }]);
        },
      }),
    }),
  };
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(systemDb),
  };
});

const { postgresRoleStore } = await import("./iam-roles");

/** A transaction that fails the test if the count is taken on it. */
const callerTx = new Proxy(
  {},
  {
    get() {
      calls.usedCallerTx = true;
      throw new Error(
        "activeAssignmentCount must not read the caller's tenant transaction",
      );
    },
  },
) as Parameters<typeof postgresRoleStore>[0];

/**
 * Every value bound into a drizzle predicate. The predicate is a graph with
 * cycles (a column points at its table, which points back), so it is walked
 * with a seen-set rather than serialised.
 */
function boundValues(node: unknown, seen = new Set<unknown>()): string[] {
  if (typeof node === "string") return [node];
  if (node === null || typeof node !== "object") return [];
  if (seen.has(node)) return [];
  seen.add(node);
  const children = Array.isArray(node) ? node : Object.values(node);
  return children.flatMap((child) => boundValues(child, seen));
}

const ORG = "00000000-0000-0000-0000-0000000000a1";
const ROLE = "00000000-0000-0000-0000-0000000000r1";

describe("postgresRoleStore.activeAssignmentCount", () => {
  beforeEach(() => {
    calls.predicates = [];
    calls.usedCallerTx = false;
    calls.count = 0;
  });

  it("does not read the caller's tenant transaction", async () => {
    await postgresRoleStore(callerTx).activeAssignmentCount(ORG, ROLE);
    expect(calls.usedCallerTx).toBe(false);
  });

  it("answers the count the system transaction returned", async () => {
    calls.count = 3;
    expect(
      await postgresRoleStore(callerTx).activeAssignmentCount(ORG, ROLE),
    ).toBe(3);
  });

  it("answers 0 when the system transaction returns no row", async () => {
    const empty = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };
    const db = await import("@oxagen/database");
    const spy = vi
      .spyOn(db, "withSystemDb")
      .mockImplementation(
        (fn: (tx: never) => Promise<unknown>) => fn(empty as never) as never,
      );
    expect(
      await postgresRoleStore(callerTx).activeAssignmentCount(ORG, ROLE),
    ).toBe(0);
    spy.mockRestore();
  });

  it("fences the read on the org, which is the whole of its isolation", async () => {
    await postgresRoleStore(callerTx).activeAssignmentCount(ORG, ROLE);
    expect(calls.predicates).toHaveLength(1);
    // The org id has to be one of the values bound into the predicate, or the
    // read is unfenced across tenants.
    expect(boundValues(calls.predicates[0])).toContain(ORG);
  });

  it("fences the read on the role as well as the org", async () => {
    await postgresRoleStore(callerTx).activeAssignmentCount(ORG, ROLE);
    expect(boundValues(calls.predicates[0])).toContain(ROLE);
  });
});
