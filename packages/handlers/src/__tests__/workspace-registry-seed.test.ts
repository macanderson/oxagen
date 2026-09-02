/**
 * TDD: workspace registry seed — exactly one default registry per workspace
 *
 * Asserts that `seedWorkspaceDefaultRegistry`:
 *   - inserts exactly one row with is_default=true and the correct base_url
 *   - is idempotent (select-first; skips insert when row already exists)
 *   - throws when insert returns no row (DB anomaly guard)
 *
 * Uses the same mocking pattern as workspace.create.test.ts (vi.mock on
 * @oxagen/database, hoisted stubs).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  registryFindFirst: vi.fn(),
  registryInsertValues: vi.fn(),
  registryInsertValuesReturning: vi.fn(),
  registryInsert: vi.fn(),
}));

// Default: no existing registry (fresh workspace)
mocks.registryFindFirst.mockResolvedValue(undefined);
mocks.registryInsertValuesReturning.mockResolvedValue([{ id: "mreg_abc123" }]);
mocks.registryInsertValues.mockReturnValue({
  returning: mocks.registryInsertValuesReturning,
});
mocks.registryInsert.mockReturnValue({ values: mocks.registryInsertValues });

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const makeTx = () => ({
    query: {
      mcpRegistries: { findFirst: mocks.registryFindFirst },
    },
    insert: mocks.registryInsert,
  });
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  };
});

import {
  seedWorkspaceDefaultRegistry,
  seedWorkspaceDefaultRegistrySystem,
  OFFICIAL_MCP_REGISTRY_NAME,
  OFFICIAL_MCP_REGISTRY_BASE_URL,
} from "../workspace-registry-seed";

// ─────────────────────────────────────────────────────────────────────────────

describe("seedWorkspaceDefaultRegistry", () => {
  const orgId = "org_test_1";
  const workspaceId = "ws_test_1";

  beforeEach(() => {
    mocks.registryFindFirst.mockClear();
    mocks.registryInsert.mockClear();
    mocks.registryInsertValues.mockClear();
    mocks.registryInsertValuesReturning.mockClear();
    // Restore defaults
    mocks.registryFindFirst.mockResolvedValue(undefined);
    mocks.registryInsertValuesReturning.mockResolvedValue([
      { id: "mreg_abc123" },
    ]);
    mocks.registryInsertValues.mockReturnValue({
      returning: mocks.registryInsertValuesReturning,
    });
    mocks.registryInsert.mockReturnValue({
      values: mocks.registryInsertValues,
    });
  });

  it("inserts exactly one registry row when none exists", async () => {
    const id = await seedWorkspaceDefaultRegistry({ orgId, workspaceId });
    expect(id).toBe("mreg_abc123");
    expect(mocks.registryInsert).toHaveBeenCalledTimes(1);
  });

  it("inserted values include is_default=true and the correct base_url (no /v0.1/servers suffix)", async () => {
    await seedWorkspaceDefaultRegistry({ orgId, workspaceId });
    const insertPayload = mocks.registryInsertValues.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload).toBeDefined();
    expect(insertPayload["isDefault"]).toBe(true);
    expect(insertPayload["baseUrl"]).toBe(
      "https://registry.modelcontextprotocol.io",
    );
    expect(insertPayload["enabled"]).toBe(true);
    expect(insertPayload["orgId"]).toBe(orgId);
    expect(insertPayload["workspaceId"]).toBe(workspaceId);
  });

  it("the exported OFFICIAL_MCP_REGISTRY_BASE_URL has no /v0.1/servers suffix", () => {
    expect(OFFICIAL_MCP_REGISTRY_BASE_URL).toBe(
      "https://registry.modelcontextprotocol.io",
    );
  });

  it("the exported OFFICIAL_MCP_REGISTRY_NAME is correct", () => {
    expect(OFFICIAL_MCP_REGISTRY_NAME).toBe("Official MCP Registry");
  });

  it("is idempotent — returns existing id and issues no insert when row already exists", async () => {
    mocks.registryFindFirst.mockResolvedValue({ id: "mreg_existing" });

    const id = await seedWorkspaceDefaultRegistry({ orgId, workspaceId });

    expect(id).toBe("mreg_existing");
    expect(mocks.registryInsert).not.toHaveBeenCalled();
  });

  it("returns the newly inserted registry id", async () => {
    mocks.registryInsertValuesReturning.mockResolvedValue([
      { id: "mreg_fresh_789" },
    ]);
    const id = await seedWorkspaceDefaultRegistry({ orgId, workspaceId });
    expect(id).toBe("mreg_fresh_789");
  });

  it("throws when the insert returns no row (DB anomaly guard)", async () => {
    mocks.registryInsertValuesReturning.mockResolvedValue([]);
    await expect(
      seedWorkspaceDefaultRegistry({ orgId, workspaceId }),
    ).rejects.toThrow("registry insert returned no row");
  });

  it("produces exactly one default registry (not zero, not two)", async () => {
    // Simulates that the test for exactly-one is met by checking insert count
    const id = await seedWorkspaceDefaultRegistry({ orgId, workspaceId });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // Insert called once — not twice, not zero times when no prior row
    expect(mocks.registryInsert).toHaveBeenCalledTimes(1);
  });
});

// ── seedWorkspaceDefaultRegistrySystem ───────────────────────────────────────

describe("seedWorkspaceDefaultRegistrySystem", () => {
  const orgId = "org_sys_1";
  const workspaceId = "ws_sys_1";

  beforeEach(() => {
    mocks.registryFindFirst.mockClear();
    mocks.registryInsert.mockClear();
    mocks.registryInsertValues.mockClear();
    mocks.registryInsertValuesReturning.mockClear();
    // Restore defaults
    mocks.registryFindFirst.mockResolvedValue(undefined);
    mocks.registryInsertValuesReturning.mockResolvedValue([
      { id: "mreg_sys_abc" },
    ]);
    mocks.registryInsertValues.mockReturnValue({
      returning: mocks.registryInsertValuesReturning,
    });
    mocks.registryInsert.mockReturnValue({
      values: mocks.registryInsertValues,
    });
  });

  it("inserts exactly one registry row when none exists (System variant)", async () => {
    const id = await seedWorkspaceDefaultRegistrySystem({ orgId, workspaceId });
    expect(id).toBe("mreg_sys_abc");
    expect(mocks.registryInsert).toHaveBeenCalledTimes(1);
  });

  it("inserted values include is_default=true and the correct base_url (System variant)", async () => {
    await seedWorkspaceDefaultRegistrySystem({ orgId, workspaceId });
    const insertPayload = mocks.registryInsertValues.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(insertPayload).toBeDefined();
    expect(insertPayload["isDefault"]).toBe(true);
    expect(insertPayload["baseUrl"]).toBe(
      "https://registry.modelcontextprotocol.io",
    );
    expect(insertPayload["enabled"]).toBe(true);
    expect(insertPayload["orgId"]).toBe(orgId);
    expect(insertPayload["workspaceId"]).toBe(workspaceId);
  });

  it("is idempotent — returns existing id and issues no insert when row already exists (System variant)", async () => {
    mocks.registryFindFirst.mockResolvedValue({ id: "mreg_sys_existing" });
    const id = await seedWorkspaceDefaultRegistrySystem({ orgId, workspaceId });
    expect(id).toBe("mreg_sys_existing");
    expect(mocks.registryInsert).not.toHaveBeenCalled();
  });

  it("throws when the insert returns no row (DB anomaly guard — System variant)", async () => {
    mocks.registryInsertValuesReturning.mockResolvedValue([]);
    await expect(
      seedWorkspaceDefaultRegistrySystem({ orgId, workspaceId }),
    ).rejects.toThrow("registry insert returned no row");
  });

  it("System variant shares the same runSeed logic as the tenant variant (same insert shape)", async () => {
    await seedWorkspaceDefaultRegistrySystem({ orgId, workspaceId });
    const sysPayload = mocks.registryInsertValues.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;

    mocks.registryInsert.mockClear();
    mocks.registryInsertValues.mockClear();
    mocks.registryInsertValuesReturning.mockClear();
    mocks.registryFindFirst.mockResolvedValue(undefined);
    mocks.registryInsertValuesReturning.mockResolvedValue([
      { id: "mreg_tenant_abc" },
    ]);
    mocks.registryInsertValues.mockReturnValue({
      returning: mocks.registryInsertValuesReturning,
    });
    mocks.registryInsert.mockReturnValue({
      values: mocks.registryInsertValues,
    });

    await seedWorkspaceDefaultRegistry({ orgId, workspaceId });
    const tenantPayload = mocks.registryInsertValues.mock
      .calls[0]?.[0] as Record<string, unknown>;

    // Both variants produce the same insert payload shape.
    expect(sysPayload["isDefault"]).toBe(tenantPayload["isDefault"]);
    expect(sysPayload["baseUrl"]).toBe(tenantPayload["baseUrl"]);
    expect(sysPayload["enabled"]).toBe(tenantPayload["enabled"]);
    expect(sysPayload["name"]).toBe(tenantPayload["name"]);
  });
});
