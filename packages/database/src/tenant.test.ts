import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async () => undefined),
  transaction: vi.fn(),
  rlsEnforced: vi.fn(() => false),
}));

mocks.transaction.mockImplementation(
  async (cb: (tx: unknown) => Promise<unknown>) => cb({ execute: mocks.execute }),
);

vi.mock("./client", () => ({ db: () => ({ transaction: mocks.transaction }) }));
// rlsEnforced reads env; stub it so the test controls the branch.
vi.mock("./tenant-flag", () => ({ rlsEnforced: mocks.rlsEnforced }));

import { runInTenantScope } from "@oxagen/tenancy";
import { withTenantDb } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

function sqlText(call: unknown): string {
  // drizzle sql`` template → capture via the mock arg's queryChunks/strings.
  return JSON.stringify(call);
}

beforeEach(() => {
  mocks.execute.mockClear();
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
