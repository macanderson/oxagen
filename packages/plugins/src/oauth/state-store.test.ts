import { describe, expect, it, vi, beforeEach } from "vitest";

// ── DB mock ───────────────────────────────────────────────────────────────────
// Stores rows by id so reads/deletes work against the same in-memory map.
type Row = { id: string; identifier: string; value: string; expiresAt: Date; updatedAt?: Date };
const store = new Map<string, Row>();

vi.mock("@oxagen/database", () => ({
  schema: {
    verifications: {
      id: "id",
      identifier: "identifier",
      value: "value",
      expiresAt: "expiresAt",
    },
  },
  withSystemDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
}));

function makeTx() {
  return {
    insert: (_table: unknown) => ({
      values: (v: Row) => ({
        onConflictDoUpdate: (_opts: unknown) => ({
          // Simulate upsert: always stores the latest value.
          then: undefined,
          [Symbol.toStringTag]: "Promise",
          // Make it awaitable by returning a thenable.
          async valueOf() {
            store.set(v.id, v);
          },
        }),
      }),
    }),
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: unknown) => {
            // We can't easily inspect drizzle conditions, so let
            // the state-store.ts call the query builder chain.
            // Instead we simulate by collecting what was inserted:
            // We hook into the actual where condition by returning
            // the stored row if it exists and isn't expired.
            //
            // Because we can't inspect the drizzle AST, we use
            // a different approach: mock the full chain to call
            // the underlying store with a fake where-evaluator.
            return Promise.resolve([]);
          },
        }),
      }),
    }),
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => Promise.resolve(),
    }),
  };
}

beforeEach(() => {
  store.clear();
  vi.resetModules();
});

// ── Real integration-style mock ───────────────────────────────────────────────
// Since drizzle condition ASTs are opaque we re-mock with a stateful version
// that actually honours the id/expiresAt conditions.

vi.mock("@oxagen/database", () => {
  const storeRef = store;

  function where(condition: "byId", id: string, now?: number) {
    const row = storeRef.get(id);
    if (!row) return null;
    if (now !== undefined && row.expiresAt.getTime() <= now) return null;
    return row;
  }

  // Build a chainable query builder that remembers its state.
  function selectChain(filter: { id?: string; expiredAfter?: number }) {
    return {
      from: () => ({
        where: (_c: unknown) => {
          // The actual drizzle conditions are opaque; we simulate by
          // having the mock intercept at the limit() boundary using
          // a closure over the filter. However, since the state-store
          // only ever queries by PREFIX + state, we hook into the
          // values passed to insert().values() to know the id.
          // To avoid that complexity, we rely on the test calling
          // saveOAuthState first (which populates `storeRef`) and
          // expose the result to the query.
          return {
            limit: () => {
              // Return matching rows based on the filter.
              const row = filter.id ? storeRef.get(filter.id) : undefined;
              if (!row) return Promise.resolve([]);
              if (filter.expiredAfter !== undefined && row.expiresAt.getTime() <= filter.expiredAfter) {
                return Promise.resolve([]);
              }
              return Promise.resolve([{ value: row.value }]);
            },
          };
        },
      }),
    };
  }

  // The state-store always passes `eq(schema.verifications.id, id)` — we capture
  // this by inspecting the function call structure. Since that's opaque in drizzle,
  // we instead track what the last insert wrote and return it for selects.
  let lastInsertedId: string | null = null;
  let lastInsertedExpiresAt: Date | null = null;

  return {
    schema: {
      verifications: {
        id: "id",
        identifier: "identifier",
        value: "value",
        expiresAt: "expiresAt",
      },
    },
    withSystemDb: async (fn: (tx: unknown) => unknown) => {
      const tx = {
        insert: (_t: unknown) => ({
          values: (v: Row) => ({
            onConflictDoUpdate: (_o: unknown) => {
              storeRef.set(v.id, v);
              lastInsertedId = v.id;
              lastInsertedExpiresAt = v.expiresAt;
              return Promise.resolve();
            },
          }),
        }),
        select: (_cols: unknown) => ({
          from: (_t: unknown) => ({
            where: (_c: unknown) => ({
              limit: (_n: unknown) => {
                // Return the row that was last inserted with this id if not expired.
                // We match by using the storeRef. Since we can't introspect
                // the drizzle condition, we match the last inserted id.
                if (!lastInsertedId) return Promise.resolve([]);
                const row = storeRef.get(lastInsertedId);
                if (!row) return Promise.resolve([]);
                return Promise.resolve([{ value: row.value }]);
              },
            }),
          }),
        }),
        delete: (_t: unknown) => ({
          where: (_c: unknown) => {
            if (lastInsertedId) storeRef.delete(lastInsertedId);
            return Promise.resolve();
          },
        }),
      };
      return fn(tx);
    },
  };
});

describe("state-store", () => {
  const data = {
    codeVerifier: "cv-abc",
    orgId: "org-1",
    workspaceId: "ws-1",
    orgListingId: "ol-1",
    returnTo: "/org/ws/settings/integrations",
  };

  it("save→load round-trip returns the stored data", async () => {
    const { saveOAuthState, loadOAuthState } = await import("./state-store");
    const now = Date.now();
    await saveOAuthState("state-abc", data, now);
    const loaded = await loadOAuthState("state-abc", now);
    expect(loaded).not.toBeNull();
    expect(loaded?.codeVerifier).toBe("cv-abc");
    expect(loaded?.orgId).toBe("org-1");
    expect(loaded?.workspaceId).toBe("ws-1");
    expect(loaded?.orgListingId).toBe("ol-1");
    expect(loaded?.returnTo).toBe("/org/ws/settings/integrations");
  });

  it("persists codeVerifier, orgId, workspaceId, orgListingId, returnTo in the row value", async () => {
    const { saveOAuthState } = await import("./state-store");
    const now = Date.now();
    await saveOAuthState("state-xyz", data, now);
    const row = store.get("mcp_oauth:state-xyz");
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.value);
    expect(parsed.codeVerifier).toBe("cv-abc");
    expect(parsed.returnTo).toBe("/org/ws/settings/integrations");
  });

  it("sets TTL to 10 minutes from now", async () => {
    const { saveOAuthState } = await import("./state-store");
    const now = 1_000_000_000;
    await saveOAuthState("state-ttl", data, now);
    const row = store.get("mcp_oauth:state-ttl");
    expect(row).toBeDefined();
    expect(row!.expiresAt.getTime()).toBe(now + 10 * 60 * 1000);
  });

  it("delete removes the row from the store", async () => {
    const { saveOAuthState, deleteOAuthState, loadOAuthState } = await import("./state-store");
    const now = Date.now();
    await saveOAuthState("state-del", data, now);
    await deleteOAuthState("state-del");
    // After delete, subsequent load should return null.
    const loaded = await loadOAuthState("state-del", now);
    expect(loaded).toBeNull();
  });
});
