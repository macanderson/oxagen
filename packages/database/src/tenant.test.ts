import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async () => undefined),
  transaction: vi.fn(),
  rlsEnforced: vi.fn(() => false),
  // For assertRlsConnectionSafe — db().execute returns rows directly (no .transaction).
  dbExecute: vi.fn(async () => [] as unknown[]),
  recordIfUnscoped: vi.fn(),
}));

mocks.transaction.mockImplementation(
  async (cb: (tx: unknown) => Promise<unknown>) => cb({ execute: mocks.execute }),
);

vi.mock("./client", () => ({
  db: () => ({ transaction: mocks.transaction, execute: mocks.dbExecute }),
}));
// rlsEnforced reads env; stub it so the test controls the branch.
vi.mock("./tenant-flag", () => ({ rlsEnforced: mocks.rlsEnforced }));
// Spy on the unscoped-access meter so we can assert withSystemDb wires it.
vi.mock("./unscoped-meter", () => ({
  recordIfUnscoped: mocks.recordIfUnscoped,
  __unscopedCountForTests: () => 0,
}));

import { runInTenantScope } from "@oxagen/tenancy";
import { withTenantDb, withSystemDb, assertRlsConnectionSafe } from "./tenant";

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
});
