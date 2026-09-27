// tenant.data-plane.test.ts — withTenantDb / withSystemDb against the ADR-042
// organisation-scoped plane seam.
//
// Invariants:
//   1. With no resolver injected, withTenantDb uses the SHARED singleton —
//      byte-for-byte the pre-ADR-042 behaviour.
//   2. A `dedicated` binding routes the transaction to the per-organisation
//      pool AND still sets the same three RLS GUCs.
//   3. A degraded/disabled plane throws DataPlaneUnavailableError and NEVER
//      opens a transaction on the shared plane.
//   4. withSystemDb always uses the shared plane and never consults the
//      resolver (it is how the resolver reads its own table).
//   5. `{ plane: "shared" }` opens withTenantDb and withOrgDb on the shared
//      plane for a dedicated organisation, with the same GUCs (#4315, #4338).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sharedTransaction: vi.fn(),
  dedicatedTransaction: vi.fn(),
  execute: vi.fn(async () => undefined),
  dedicatedDb: vi.fn(),
  rlsEnforced: vi.fn(() => true),
  recordIfUnscoped: vi.fn(),
}));

const runTx = async (cb: (tx: unknown) => Promise<unknown>) =>
  cb({ execute: mocks.execute });
mocks.sharedTransaction.mockImplementation(runTx);
mocks.dedicatedTransaction.mockImplementation(runTx);

vi.mock("./client", () => ({
  db: () => ({ transaction: mocks.sharedTransaction }),
}));
vi.mock("./data-plane-pool", () => ({
  dedicatedDb: (args: unknown) => {
    mocks.dedicatedDb(args);
    return { transaction: mocks.dedicatedTransaction };
  },
}));
vi.mock("./tenant-flag", () => ({ rlsEnforced: mocks.rlsEnforced }));
vi.mock("./unscoped-meter", () => ({
  recordIfUnscoped: mocks.recordIfUnscoped,
  __unscopedCountForTests: () => 0,
}));

import {
  clearDataPlaneResolver,
  DataPlaneUnavailableError,
  runInTenantScope,
  setDataPlaneResolver,
  type DataPlaneStatus,
} from "@oxagen/tenancy";
import { withOrgDb, withSystemDb, withTenantDb } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

const DEDICATED_CONFIG = {
  host: "pg.acme.example",
  port: 5432,
  database: "acme",
  username: "acme_app",
  password: "s3cret",
};

/** JSON of the drizzle sql`` template, for GUC assertions. */
function gucText(): string {
  return JSON.stringify(mocks.execute.mock.calls);
}

/**
 * The value bound right after `name` in the first GUC statement. The
 * template's own text holds a literal `'off'` (`app.org_wide`), so a search
 * of the whole text cannot tell which value the bypass GUC received.
 */
function boundAfter(name: string): unknown {
  const calls = mocks.execute.mock.calls as unknown as Array<
    [{ queryChunks: unknown[] }]
  >;
  const chunks = calls[0]?.[0].queryChunks ?? [];
  const at = chunks.findIndex((chunk) => {
    const value = (chunk as { value?: unknown }).value;
    return Array.isArray(value) && value.join("").includes(name);
  });
  return at === -1 ? undefined : chunks[at + 1];
}

beforeEach(() => {
  mocks.sharedTransaction.mockClear();
  mocks.dedicatedTransaction.mockClear();
  mocks.dedicatedDb.mockClear();
  mocks.execute.mockClear();
  mocks.recordIfUnscoped.mockClear();
});

afterEach(() => clearDataPlaneResolver());

describe("withTenantDb — shared plane (default)", () => {
  it("uses the process singleton when no resolver is injected", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => "ok"),
    );
    expect(mocks.sharedTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.dedicatedDb).not.toHaveBeenCalled();
  });

  it("uses the singleton for an explicit shared binding", async () => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "shared",
      status: "active",
    }));
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => "ok"),
    );
    expect(mocks.sharedTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.dedicatedDb).not.toHaveBeenCalled();
  });
});

describe("withTenantDb — dedicated plane", () => {
  beforeEach(() => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "dedicated",
      status: "active",
      config: DEDICATED_CONFIG,
      configDigest: "digest-1",
    }));
  });

  it("routes the transaction to the per-organisation pool", async () => {
    const out = await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => "dedicated-ok"),
    );
    expect(out).toBe("dedicated-ok");
    expect(mocks.dedicatedTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.sharedTransaction).not.toHaveBeenCalled();
  });

  it("keys the pool by organisation id and config digest", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => null),
    );
    expect(mocks.dedicatedDb).toHaveBeenCalledWith({
      orgId: ORG,
      config: DEDICATED_CONFIG,
      configDigest: "digest-1",
    });
  });

  it("sets the SAME RLS GUCs on the dedicated plane as on the shared one", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => null),
    );
    const text = gucText();
    expect(text).toContain("app.current_org_id");
    expect(text).toContain("app.current_workspace_id");
    expect(text).toContain("app.rls_bypass");
    expect(text).toContain(ORG);
    expect(text).toContain(WS);
    // rlsEnforced() is true in this suite → bypass must be 'off'.
    expect(boundAfter("app.rls_bypass")).toBe("off");
  });

  it("resolves the plane for the SCOPE's organisation", async () => {
    const other = "00000000-0000-0000-0000-00000000c333";
    await runInTenantScope({ orgId: other, workspaceId: WS }, () =>
      withTenantDb(async () => null),
    );
    expect(mocks.dedicatedDb).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: other }),
    );
  });
});

describe("withTenantDb — fail closed", () => {
  it.each<DataPlaneStatus>(["degraded", "disabled"])(
    "throws for a %s plane and opens no transaction anywhere",
    async (status) => {
      setDataPlaneResolver(async (orgId, kind) => ({
        orgId,
        kind,
        mode: "dedicated",
        status,
        config: DEDICATED_CONFIG,
      }));
      await expect(
        runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
          withTenantDb(async () => null),
        ),
      ).rejects.toThrow(DataPlaneUnavailableError);
      expect(mocks.sharedTransaction).not.toHaveBeenCalled();
      expect(mocks.dedicatedTransaction).not.toHaveBeenCalled();
    },
  );

  it("throws for a dedicated binding that arrived without a config", async () => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "dedicated",
      status: "active",
    }));
    await expect(
      runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
        withTenantDb(async () => null),
      ),
    ).rejects.toThrow(DataPlaneUnavailableError);
    expect(mocks.dedicatedDb).not.toHaveBeenCalled();
  });
});

describe("withSystemDb — always the shared plane", () => {
  it("never consults the resolver, even for a dedicated organisation", async () => {
    const resolver = vi.fn(async (orgId: string, kind: never) => ({
      orgId,
      kind,
      mode: "dedicated" as const,
      status: "active" as const,
      config: DEDICATED_CONFIG,
    }));
    setDataPlaneResolver(resolver as never);
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withSystemDb(async () => "system-ok"),
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(mocks.sharedTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.dedicatedDb).not.toHaveBeenCalled();
  });

  it("still runs on the shared plane when a plane is disabled", async () => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "shared",
      status: "disabled",
    }));
    await expect(withSystemDb(async () => "ok")).resolves.toBe("ok");
    expect(mocks.sharedTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('the shared plane option, { plane: "shared" }', () => {
  beforeEach(() => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "dedicated",
      status: "active",
      config: DEDICATED_CONFIG,
    }));
  });

  it("opens withTenantDb on the shared plane for a dedicated organisation", async () => {
    const out = await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => "billing-ok", { plane: "shared" }),
    );
    expect(out).toBe("billing-ok");
    expect(mocks.sharedTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.dedicatedDb).not.toHaveBeenCalled();
  });

  it("opens withOrgDb on the shared plane for a dedicated organisation", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withOrgDb(async () => null, { plane: "shared" }),
    );
    expect(mocks.sharedTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.dedicatedDb).not.toHaveBeenCalled();
    expect(boundAfter("app.rls_bypass")).toBe("off");
  });

  it("never asks the resolver, so a disabled dedicated plane does not stop it", async () => {
    const resolver = vi.fn(async (orgId: string, kind: never) => ({
      orgId,
      kind,
      mode: "dedicated" as const,
      status: "disabled" as const,
      config: DEDICATED_CONFIG,
    }));
    setDataPlaneResolver(resolver as never);
    await expect(
      runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
        withTenantDb(async () => "ok", { plane: "shared" }),
      ),
    ).resolves.toBe("ok");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("sets the tenant GUCs, so RLS still fences the rows", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => null, { plane: "shared" }),
    );
    const text = gucText();
    expect(text).toContain("app.current_org_id");
    expect(text).toContain("app.current_workspace_id");
    expect(text).toContain(ORG);
    expect(text).toContain(WS);
    expect(boundAfter("app.rls_bypass")).toBe("off");
    expect(mocks.recordIfUnscoped).not.toHaveBeenCalled();
  });

  it("binds 'on' to the bypass GUC when enforcement is off", async () => {
    mocks.rlsEnforced.mockReturnValueOnce(false);
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => null, { plane: "shared" }),
    );
    expect(boundAfter("app.rls_bypass")).toBe("on");
  });

  it("refuses to run without a tenant scope", async () => {
    await expect(
      withTenantDb(async () => null, { plane: "shared" }),
    ).rejects.toThrow();
    expect(mocks.sharedTransaction).not.toHaveBeenCalled();
  });
});
