import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async () => undefined),
  transaction: vi.fn(),
  rlsEnforced: vi.fn(() => false),
  // For assertRlsConnectionSafe — db().execute returns rows directly (no .transaction).
  dbExecute: vi.fn(async () => [] as unknown[]),
  recordIfUnscoped: vi.fn(),
  // Controls the fail-closed-in-production guard branch.
  isProductionRuntime: vi.fn(() => false),
}));

mocks.transaction.mockImplementation(
  async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ execute: mocks.execute }),
);

vi.mock("./client", () => ({
  db: () => ({ transaction: mocks.transaction, execute: mocks.dbExecute }),
}));
// rlsEnforced reads env; stub it so the test controls the branch.
vi.mock("./tenant-flag", () => ({ rlsEnforced: mocks.rlsEnforced }));
// isProductionRuntime reads ambient env; stub it so the test controls the
// fail-closed-in-production guard without mutating process.env.
vi.mock("@oxagen/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/config/env")>();
  return { ...actual, isProductionRuntime: mocks.isProductionRuntime };
});
// Spy on the unscoped-access meter so we can assert withSystemDb wires it.
vi.mock("./unscoped-meter", () => ({
  recordIfUnscoped: mocks.recordIfUnscoped,
  __unscopedCountForTests: () => 0,
}));

import { runInTenantScope } from "@oxagen/tenancy";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import {
  withTenantDb,
  withTransactionOrgScope,
  type Tx,
  withOrgDb,
  withRepeatableReadTenantDb,
  withSystemDb,
  setTransactionWorkspaceScope,
  assertRlsConnectionSafe,
  assertRlsEnforcedInProduction,
  isOrgOnlyWorkspaceReadRefusal,
  ORG_ONLY_WORKSPACE_GUC,
} from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

function sqlText(call: unknown): string {
  // drizzle sql`` template → capture via the mock arg's queryChunks/strings.
  return JSON.stringify(call);
}

beforeEach(() => {
  mocks.execute.mockClear();
  mocks.dbExecute.mockClear();
  mocks.recordIfUnscoped.mockClear();
  mocks.rlsEnforced.mockReturnValue(false);
  mocks.isProductionRuntime.mockReturnValue(false);
});

describe("withTenantDb", () => {
  it("requires an active scope (fail-closed)", async () => {
    await expect(withTenantDb(async () => 1)).rejects.toThrow(/tenant scope/);
  });

  it("sets org + workspace GUCs and bypass='on' when enforcement is off", async () => {
    const result = await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async (tx) => {
        expect(tx).toBeDefined();
        return "ok";
      }),
    );
    expect(result).toBe("ok");
    expect(mocks.execute).toHaveBeenCalledTimes(1); // one set_config statement
    const calls1 = mocks.execute.mock.calls as unknown[][];
    const arg = sqlText((calls1[0] as unknown[])[0]);
    expect(arg).toContain("app.current_org_id");
    expect(arg).toContain("app.current_workspace_id");
    // Enforcement off → bypass='on'
    expect(arg).toContain("app.rls_bypass");
    expect(arg).toContain('"on"');
  });

  it("sets bypass='off' when enforcement is enabled", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => undefined),
    );
    const calls2 = mocks.execute.mock.calls as unknown[][];
    const arg = sqlText((calls2[0] as unknown[])[0]);
    // Enforcement on → bypass='off' (always set, never absent)
    expect(arg).toContain("app.rls_bypass");
    expect(arg).toContain('"off"');
    expect(arg).not.toContain('"on"');
  });
});

describe("the org-only workspace GUC (#3132, ADR-086)", () => {
  // The seam is the one place the translation happens, and the whole refusal
  // rests on the value NOT being a uuid. A test that only checked "the GUC is
  // set" would pass on the nil uuid that caused the defect.
  it("is not a uuid, so a policy that casts it raises", () => {
    expect(ORG_ONLY_WORKSPACE_GUC).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(ORG_ONLY_WORKSPACE_GUC).not.toBe(ORG_ONLY_WORKSPACE_ID);
  });

  it("withTenantDb translates the org-only sentinel into the marker", async () => {
    await runInTenantScope(
      { orgId: ORG, workspaceId: ORG_ONLY_WORKSPACE_ID },
      () => withTenantDb(async () => undefined),
    );
    const arg = sqlText((mocks.execute.mock.calls[0] as unknown[])[0]);
    expect(arg).toContain(ORG_ONLY_WORKSPACE_GUC);
    expect(arg).not.toContain(ORG_ONLY_WORKSPACE_ID);
  });

  it("withTenantDb passes a real workspace through untouched", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => undefined),
    );
    const arg = sqlText((mocks.execute.mock.calls[0] as unknown[])[0]);
    expect(arg).toContain(WS);
    expect(arg).not.toContain(ORG_ONLY_WORKSPACE_GUC);
  });

  it("withRepeatableReadTenantDb translates it the same way", async () => {
    await runInTenantScope(
      { orgId: ORG, workspaceId: ORG_ONLY_WORKSPACE_ID },
      () => withRepeatableReadTenantDb(async () => undefined),
    );
    // [0] is SET TRANSACTION ISOLATION LEVEL; the GUCs are [1].
    const arg = sqlText((mocks.execute.mock.calls[1] as unknown[])[0]);
    expect(arg).toContain(ORG_ONLY_WORKSPACE_GUC);
  });

  it("withTenantDb pins app.org_wide off, so a tenant read can never widen", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => undefined),
    );
    const arg = sqlText((mocks.execute.mock.calls[0] as unknown[])[0]);
    // A SQL literal, not a bound parameter: the value is never a caller's to
    // choose, so it is spelled in the statement.
    expect(arg).toContain("app.org_wide");
    expect(arg).toContain("'off'");
  });

  describe("isOrgOnlyWorkspaceReadRefusal", () => {
    it("matches 22P02 carrying the marker", () => {
      expect(
        isOrgOnlyWorkspaceReadRefusal({
          code: "22P02",
          message: `invalid input syntax for type uuid: "${ORG_ONLY_WORKSPACE_GUC}"`,
        }),
      ).toBe(true);
    });

    it("walks the drizzle cause chain", () => {
      expect(
        isOrgOnlyWorkspaceReadRefusal({
          message: "Failed query",
          cause: {
            code: "22P02",
            message: `invalid input syntax for type uuid: "${ORG_ONLY_WORKSPACE_GUC}"`,
          },
        }),
      ).toBe(true);
    });

    // A caller passing a malformed uuid from a path param raises the same
    // SQLSTATE. Calling that "an org-only read of a workspace-scoped table"
    // would be a second wrong answer dressed as a diagnosis.
    it("does not match a 22P02 from some other malformed uuid", () => {
      expect(
        isOrgOnlyWorkspaceReadRefusal({
          code: "22P02",
          message: 'invalid input syntax for type uuid: "not-a-uuid"',
        }),
      ).toBe(false);
    });

    it("does not match a non-Postgres error", () => {
      expect(isOrgOnlyWorkspaceReadRefusal(new Error("boom"))).toBe(false);
      expect(isOrgOnlyWorkspaceReadRefusal(null)).toBe(false);
    });
  });
});

describe("withOrgDb", () => {
  it("requires an active scope (fail-closed, same as withTenantDb)", async () => {
    await expect(withOrgDb(async () => 1)).rejects.toThrow(/tenant scope/);
  });

  // The three GUCs that make it an organisation-wide read: the org fence stays
  // with the database, the workspace GUC is EMPTY (so the cast yields NULL
  // rather than raising), and app.org_wide is what widens the USING clause.
  it("sets the org GUC, empties the workspace GUC and turns app.org_wide on", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withOrgDb(async () => undefined),
    );
    const arg = sqlText((mocks.execute.mock.calls[0] as unknown[])[0]);
    expect(arg).toContain("app.current_org_id");
    expect(arg).toContain(ORG);
    expect(arg).toContain("app.org_wide");
    expect(arg).toContain("'on'");
    // Never the marker: it would raise at plan time on every policy that names
    // the GUC, org-wide disjunct or not.
    expect(arg).not.toContain(ORG_ONLY_WORKSPACE_GUC);
    // And never the caller's workspace, so a nested call cannot inherit it.
    expect(arg).not.toContain(WS);
  });

  it("ignores the workspace in scope, including the org-only sentinel", async () => {
    await runInTenantScope(
      { orgId: ORG, workspaceId: ORG_ONLY_WORKSPACE_ID },
      () => withOrgDb(async () => undefined),
    );
    const arg = sqlText((mocks.execute.mock.calls[0] as unknown[])[0]);
    expect(arg).not.toContain(ORG_ONLY_WORKSPACE_GUC);
    expect(arg).toContain("'on'");
  });

  it("honours the enforcement flag like withTenantDb", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withOrgDb(async () => undefined),
    );
    const arg = sqlText((mocks.execute.mock.calls[0] as unknown[])[0]);
    expect(arg).toContain("app.rls_bypass");
    expect(arg).toContain('"off"');
  });
});

describe("withRepeatableReadTenantDb", () => {
  it("requires an active scope (fail-closed, same as withTenantDb)", async () => {
    await expect(withRepeatableReadTenantDb(async () => 1)).rejects.toThrow(
      /tenant scope/,
    );
  });

  it("raises the isolation level BEFORE any other statement", async () => {
    // Postgres rejects SET TRANSACTION ISOLATION LEVEL once the transaction has
    // read anything, so ordering here is correctness, not style: if the
    // set_config statement ran first the snapshot would already be taken and
    // the whole point of the helper (one MVCC snapshot across the grant ceiling
    // AND its deny-generation vector) would be silently lost.
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withRepeatableReadTenantDb(async () => "ok"),
    );
    const calls = mocks.execute.mock.calls as unknown[][];
    expect(calls.length).toBe(2);
    expect(sqlText((calls[0] as unknown[])[0])).toContain(
      "set transaction isolation level repeatable read",
    );
  });

  it("sets the same tenant GUCs as withTenantDb", async () => {
    const result = await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withRepeatableReadTenantDb(async (tx) => {
        expect(tx).toBeDefined();
        return "snapshot";
      }),
    );
    expect(result).toBe("snapshot");
    const calls = mocks.execute.mock.calls as unknown[][];
    const arg = sqlText((calls[1] as unknown[])[0]);
    expect(arg).toContain("app.current_org_id");
    expect(arg).toContain("app.current_workspace_id");
    expect(arg).toContain("app.rls_bypass");
    // Enforcement off in this suite → bypass='on'.
    expect(arg).toContain('"on"');
  });

  it("sets bypass='off' when enforcement is enabled", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withRepeatableReadTenantDb(async () => undefined),
    );
    const calls = mocks.execute.mock.calls as unknown[][];
    const arg = sqlText((calls[1] as unknown[])[0]);
    expect(arg).toContain('"off"');
    expect(arg).not.toContain('"on"');
  });
});

describe("withSystemDb", () => {
  it("runs WITHOUT an active scope (the bypass escape hatch)", async () => {
    // No runInTenantScope wrapper — must not throw.
    const result = await withSystemDb(async (tx) => {
      expect(tx).toBeDefined();
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("records the call through recordIfUnscoped('withSystemDb') so the seeding-window gate has real signal", async () => {
    // The unscoped-access meter was dead code until withSystemDb wired it. The
    // bypass entry point is exactly where an unscoped DB access happens, so the
    // db.query.unscoped counter must be incremented here or the enforcement-flip
    // gate is permanently unreachable.
    await withSystemDb(async () => "ok");
    expect(mocks.recordIfUnscoped).toHaveBeenCalledTimes(1);
    expect(mocks.recordIfUnscoped).toHaveBeenCalledWith("withSystemDb");
  });

  it("sets app.rls_bypass='on' and no scope GUCs, even when enforcement is on", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    await withSystemDb(async () => undefined);
    const calls = mocks.execute.mock.calls as unknown[][];
    const arg = sqlText((calls[0] as unknown[])[0]);
    // 'on' is an inline SQL literal here (not a bound param), so it serializes
    // single-quoted inside the query text.
    expect(arg).toContain("app.rls_bypass");
    expect(arg).toContain("'on'");
    // It is a pure bypass — it must NOT set tenant scope GUCs.
    expect(arg).not.toContain("app.current_org_id");
  });
});

// ---------------------------------------------------------------------------
// assertRlsConnectionSafe
// ---------------------------------------------------------------------------

describe("assertRlsConnectionSafe", () => {
  it("is a no-op (does not query db) when enforcement is off", async () => {
    mocks.rlsEnforced.mockReturnValue(false);
    await expect(assertRlsConnectionSafe()).resolves.toBeUndefined();
    // enforcement off → early return, never calls db().execute
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });

  it("throws when enforcement is on and the role is a superuser", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    mocks.dbExecute.mockResolvedValueOnce([
      { is_superuser: "on", bypassrls: false },
    ] as unknown[]);
    await expect(assertRlsConnectionSafe()).rejects.toThrow(/superuser/i);
  });

  it("throws when enforcement is on and the role has BYPASSRLS", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    mocks.dbExecute.mockResolvedValueOnce([
      { is_superuser: "off", bypassrls: true },
    ] as unknown[]);
    await expect(assertRlsConnectionSafe()).rejects.toThrow(/BYPASSRLS/);
  });

  it("resolves (no throw) when enforcement is on and role is a non-superuser non-BYPASSRLS role", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    mocks.dbExecute.mockResolvedValueOnce([
      { is_superuser: "off", bypassrls: false },
    ] as unknown[]);
    await expect(assertRlsConnectionSafe()).resolves.toBeUndefined();
  });

  it("queries the db when enforcement is on", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    mocks.dbExecute.mockResolvedValueOnce([
      { is_superuser: "off", bypassrls: false },
    ] as unknown[]);
    await assertRlsConnectionSafe();
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
  });

  it("throws (before touching the db) when production has RLS enforcement disabled", async () => {
    mocks.isProductionRuntime.mockReturnValue(true);
    mocks.rlsEnforced.mockReturnValue(false);
    await expect(assertRlsConnectionSafe()).rejects.toThrow(
      /Refusing to start|Production runtime/i,
    );
    // The prod guard fires first — the connection-role probe never runs.
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// assertRlsEnforcedInProduction (synchronous fail-closed-in-prod guard)
// ---------------------------------------------------------------------------

describe("assertRlsEnforcedInProduction", () => {
  it("throws when production runs with enforcement disabled", () => {
    mocks.isProductionRuntime.mockReturnValue(true);
    mocks.rlsEnforced.mockReturnValue(false);
    expect(() => assertRlsEnforcedInProduction()).toThrow(
      /TENANT_RLS_ENFORCEMENT_ENABLED=false|Refusing to start/i,
    );
  });

  it("is a no-op when production runs with enforcement enabled", () => {
    mocks.isProductionRuntime.mockReturnValue(true);
    mocks.rlsEnforced.mockReturnValue(true);
    expect(() => assertRlsEnforcedInProduction()).not.toThrow();
  });

  it("is a no-op in a non-production runtime even with enforcement disabled", () => {
    mocks.isProductionRuntime.mockReturnValue(false);
    mocks.rlsEnforced.mockReturnValue(false);
    expect(() => assertRlsEnforcedInProduction()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// setTransactionWorkspaceScope — the one legal mid-transaction GUC move (#3029)
// ---------------------------------------------------------------------------

describe("setTransactionWorkspaceScope", () => {
  it("re-points app.current_workspace_id on the open transaction, locally", async () => {
    const execute = vi.fn(async (_statement: unknown) => undefined);
    await setTransactionWorkspaceScope(
      { execute } as unknown as Parameters<
        typeof setTransactionWorkspaceScope
      >[0],
      WS,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const statement = sqlText(execute.mock.calls[0]?.[0]);
    expect(statement).toContain("set_config");
    expect(statement).toContain("app.current_workspace_id");
    // `true` = transaction-local, so it rolls back with the transaction.
    expect(statement).toContain("true");
    expect(statement).toContain(WS);
  });
});

describe("withTransactionOrgScope", () => {
  it.each([false, true])(
    "restores the workspace and reuses the transaction (failure=%s)",
    async (fails) => {
      const { PgDialect } = await import("drizzle-orm/pg-core");
      const dialect = new PgDialect();
      let workspace = WS;
      const settings: string[] = [];
      const error = new Error("org assignment refused");
      const writes: string[] = [];
      const tx = {
        execute: vi.fn(async (query: import("drizzle-orm").SQL) => {
          const compiled = dialect.sqlToQuery(query);
          if (compiled.sql.includes("current_setting")) return [{ workspace }];
          workspace = compiled.params.length ? String(compiled.params[0]) : "";
          settings.push(workspace);
          return [];
        }),
        transaction: vi.fn(async (fn: (tx: Tx) => Promise<unknown>) => {
          const prior = workspace;
          const originalWrites = [...writes];
          try {
            return await fn(tx as unknown as Tx);
          } catch (e) {
            // PostgreSQL ROLLBACK TO SAVEPOINT restores local settings and writes.
            workspace = prior;
            writes.splice(0, writes.length, ...originalWrites);
            throw e;
          }
        }),
      };
      const work = withTransactionOrgScope(
        tx as unknown as Tx,
        async (orgTx) => {
          expect(orgTx).toBe(tx);
          expect(workspace).toBe("");
          writes.push("org assignment");
          if (fails) throw error;
          return "assigned";
        },
      );
      if (fails) await expect(work).rejects.toBe(error);
      else await expect(work).resolves.toBe("assigned");
      expect(workspace).toBe(WS);
      expect(writes).toEqual(fails ? [] : ["org assignment"]);
      expect(settings).toEqual(fails ? [""] : ["", WS]);
      expect(tx.transaction).toHaveBeenCalledTimes(1);
      // Scope changes name only the workspace GUC, never org_id or bypass.
      for (const [query] of tx.execute.mock.calls) {
        const text = dialect.sqlToQuery(query).sql;
        expect(text).not.toContain("app.current_org_id");
        expect(text).not.toContain("app.rls_bypass");
        expect(text).not.toContain("app.org_wide");
      }
    },
  );
});
