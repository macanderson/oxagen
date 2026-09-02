/**
 * Unit tests for workspace.budget.policy.write handler.
 *
 * Strategy: mock withTenantDb so no DB is needed. Tests cover:
 *   - INSERT path when no existing row
 *   - UPDATE path when row already exists
 *   - partial update (only one field supplied)
 *   - null limitUsd clears the limit
 *   - mode/enforcement normalization
 *   - missing workspaceId → throws before any DB access
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { workspaceBudgetPolicyWriteHandler } from "./workspace.budget_policy.write";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── tx builders ───────────────────────────────────────────────────────────────

/** Tx stub for the first withTenantDb call (findFirst). */
function makeReadTx(existingRow: Record<string, unknown> | undefined) {
  return {
    query: {
      workspaceBudgetPolicy: {
        findFirst: vi.fn().mockResolvedValue(existingRow),
      },
    },
  };
}

/** Tx stub for the second withTenantDb call (insert). */
function makeInsertTx() {
  return {
    insert: mocks.insertSpy.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

/** Tx stub for the second withTenantDb call (update). */
function makeUpdateTx() {
  return {
    update: mocks.updateSpy.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("workspaceBudgetPolicyWriteHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("INSERTs a new row and returns merged values when no existing policy", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(undefined));
        return fn(makeInsertTx());
      },
    );

    const result = await workspaceBudgetPolicyWriteHandler(
      {
        enabled: true,
        limitUsd: 10.0,
        mode: "grace",
        graceOveragePct: 0.5,
        enforcement: "default",
      },
      TEST_CTX,
    );

    expect(result.enabled).toBe(true);
    expect(result.limitUsd).toBe(10.0);
    expect(result.mode).toBe("grace");
    expect(result.graceOveragePct).toBe(0.5);
    expect(result.enforcement).toBe("default");
    // Insert path was taken.
    expect(mocks.insertSpy).toHaveBeenCalledTimes(1);
    expect(mocks.updateSpy).not.toHaveBeenCalled();
  });

  it("UPDATEs the existing row and returns merged values when policy row exists", async () => {
    const existingRow = {
      id: "bp_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      enabled: false,
      limitUsd: 5.0,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await workspaceBudgetPolicyWriteHandler(
      {
        enabled: true,
        limitUsd: 20.0,
        mode: "prompt",
        graceOveragePct: 0.1,
        enforcement: "default",
      },
      TEST_CTX,
    );

    expect(result.enabled).toBe(true);
    expect(result.limitUsd).toBe(20.0);
    expect(result.mode).toBe("prompt");
    expect(result.graceOveragePct).toBe(0.1);
    expect(result.enforcement).toBe("default");
    // Update path was taken.
    expect(mocks.updateSpy).toHaveBeenCalledTimes(1);
    expect(mocks.insertSpy).not.toHaveBeenCalled();
  });

  it("preserves existing values for fields not supplied (partial update)", async () => {
    const existingRow = {
      id: "bp_2",
      orgId: "org_1",
      workspaceId: "ws_1",
      enabled: true,
      limitUsd: 10.0,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    // Only supply limitUsd — the rest must fall back to existing.
    const result = await workspaceBudgetPolicyWriteHandler(
      { limitUsd: 15.0 },
      TEST_CTX,
    );

    expect(result.limitUsd).toBe(15.0);
    expect(result.enabled).toBe(true); // preserved from existing row
    expect(result.mode).toBe("enforce"); // preserved from existing row
    expect(result.graceOveragePct).toBe(0.25); // preserved from existing row
    expect(result.enforcement).toBe("ceiling"); // preserved from existing row
  });

  it("clears the limit when null is explicitly supplied", async () => {
    const existingRow = {
      id: "bp_3",
      orgId: "org_1",
      workspaceId: "ws_1",
      enabled: true,
      limitUsd: 10.0,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await workspaceBudgetPolicyWriteHandler(
      { limitUsd: null },
      TEST_CTX,
    );

    expect(result.limitUsd).toBeNull();
    expect(result.enabled).toBe(true); // preserved
  });

  it("partial update with only mode preserves everything else", async () => {
    const existingRow = {
      id: "bp_4",
      orgId: "org_1",
      workspaceId: "ws_1",
      enabled: true,
      limitUsd: 5.0,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "default",
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await workspaceBudgetPolicyWriteHandler(
      { mode: "grace" },
      TEST_CTX,
    );

    expect(result.mode).toBe("grace");
    expect(result.limitUsd).toBe(5.0); // preserved
    expect(result.enabled).toBe(true); // preserved
    expect(result.enforcement).toBe("default"); // preserved
  });

  it("uses defaults (enabled=false, limitUsd=null, mode=enforce, grace=0.25, enforcement=ceiling) for unspecified fields when no existing row", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(undefined));
        return fn(makeInsertTx());
      },
    );

    // Supply only enabled — the rest should be the code defaults.
    const result = await workspaceBudgetPolicyWriteHandler(
      { enabled: true },
      TEST_CTX,
    );

    expect(result.enabled).toBe(true);
    expect(result.limitUsd).toBeNull();
    expect(result.mode).toBe("enforce");
    expect(result.graceOveragePct).toBe(0.25);
    expect(result.enforcement).toBe("ceiling");
  });

  it("throws when workspaceId is missing from ctx", async () => {
    const noWsCtx = makeCTX({ workspaceId: undefined as unknown as string });

    await expect(
      workspaceBudgetPolicyWriteHandler(
        { enabled: true, limitUsd: 10.0 },
        noWsCtx,
      ),
    ).rejects.toThrow(
      "workspace.budget.policy.write requires a workspace context",
    );

    // withTenantDb must NOT be called — the guard fires before any DB access.
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("calls withTenantDb exactly twice (read then write)", async () => {
    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(undefined));
        return fn(makeInsertTx());
      },
    );

    await workspaceBudgetPolicyWriteHandler(
      { enabled: true, limitUsd: 10.0 },
      TEST_CTX,
    );

    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it("normalizes unexpected mode values to 'enforce' when merging from existing", async () => {
    const existingRow = {
      id: "bp_5",
      orgId: "org_1",
      workspaceId: "ws_1",
      enabled: true,
      limitUsd: 5.0,
      mode: "bad_mode",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await workspaceBudgetPolicyWriteHandler({}, TEST_CTX);
    expect(result.mode).toBe("enforce");
  });

  it("normalizes unexpected enforcement values to 'ceiling' when merging from existing", async () => {
    const existingRow = {
      id: "bp_6",
      orgId: "org_1",
      workspaceId: "ws_1",
      enabled: true,
      limitUsd: 5.0,
      mode: "prompt",
      graceOveragePct: 0.25,
      enforcement: "bad_enforcement",
    };

    let callCount = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) return fn(makeReadTx(existingRow));
        return fn(makeUpdateTx());
      },
    );

    const result = await workspaceBudgetPolicyWriteHandler({}, TEST_CTX);
    expect(result.enforcement).toBe("ceiling");
  });
});
