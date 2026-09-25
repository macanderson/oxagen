/**
 * plugin.org.uninstall.test.ts
 *
 * Uninstalling a capability pack must NOT remove sandbox templates it seeded
 * (Spec §6): a template may back a live agent-environment binding, so removal is
 * an explicit user action, never an uninstall side effect. This pins that
 * invariant — the handler deletes only mcp_servers rows, never sandbox_templates.
 *
 * It must also not dismantle a kill switch (ADR-071). A `tool_server` switch
 * denies on a digest over `mcp.mcp_servers.id` and a `tool_version` switch on
 * the capability id `mcp.<that uuid>.<name>`. Uninstalling hard-deletes the
 * server row, and reinstalling mints a new uuid, so the switch would match
 * nothing while `list_kill_switches` still reported it on. Uninstall needs no
 * org Owner or Admin role; a kill switch does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The handler's role gate (#4194) runs for real against a role fixture. The
// default caller is an org Owner; a case that needs another sets roleGate.
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

interface State {
  deletes: unknown[];
  updates: unknown[];
  selects: unknown[];
}
const state: State = { deletes: [], updates: [], selects: [] };

/** Rows each table's select resolves to. */
let serverRows: Array<Record<string, unknown>> = [];
let versionRows: Array<Record<string, unknown>> = [];
let killSwitchRows: Array<Record<string, unknown>> = [];

function makeTx(real: typeof import("@oxagen/database")) {
  const resolveFor = (table: unknown) => {
    if (table === real.schema.emergencyDenies) return killSwitchRows;
    if (table === real.schema.mcpServers) return serverRows;
    return versionRows;
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        state.selects.push(table);
        const rows = resolveFor(table);
        return {
          where: () => Promise.resolve(rows),
          innerJoin: () => ({ where: () => Promise.resolve(rows) }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: () => {
        state.updates.push(table);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        state.deletes.push(table);
        return Promise.resolve(undefined);
      },
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx(real)),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: vi.fn(),
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

import { handler } from "./plugin.org.uninstall";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";
import { schema } from "@oxagen/database";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

function activeSwitch(over: Record<string, unknown>) {
  return {
    id: "d1",
    publicId: "emd_9",
    scopeKind: "workspace",
    workspaceId: "ws-1",
    capabilityId: null,
    resourceScopeDigest: "digest",
    principalId: null,
    reason: "supply-chain incident",
    active: true,
    activatedAt: new Date("2026-09-16T00:00:00Z"),
    deactivatedAt: null,
    flippedByUserId: null,
    updatedById: null,
    ...over,
  };
}

beforeEach(() => {
  state.deletes = [];
  state.updates = [];
  state.selects = [];
  serverRows = [{ id: "srv-uuid-1", publicId: "mcs_acme" }];
  versionRows = [{ publicId: "tlv_1" }];
  killSwitchRows = [];
});

describe("plugin.org.uninstall", () => {
  it("soft-deletes the listing and hard-deletes its mcp servers", async () => {
    const result = await handler({ orgListingId: "porg-1" }, ctx as never);

    expect(result).toEqual({ ok: true });
    // The plugin listing is soft-deleted (update), mcp servers hard-deleted.
    expect(state.updates).toContain(schema.pluginInstalledPlugins);
    expect(state.deletes).toContain(schema.mcpServers);
    // Nothing else in the workspace is touched.
    expect(state.deletes).toEqual([schema.mcpServers]);
    expect(state.updates).toEqual([schema.pluginInstalledPlugins]);
  });

  it("refuses while a tool_server kill switch names one of its servers (ADR-071)", async () => {
    killSwitchRows = [
      activeSwitch({ targetKind: "tool_server", targetId: "mcs_acme" }),
    ];

    await expect(
      handler({ orgListingId: "porg-1" }, ctx as never),
    ).rejects.toMatchObject({ code: "conflict", reason: "kill_switch_on" });
    // The guard runs inside the same transaction, before the delete.
    expect(state.deletes).toEqual([]);
  });

  it("refuses while a tool_version kill switch names a tool of one of its servers", async () => {
    killSwitchRows = [
      activeSwitch({ targetKind: "tool_version", targetId: "tlv_1" }),
    ];

    await expect(
      handler({ orgListingId: "porg-1" }, ctx as never),
    ).rejects.toThrow(/emd_9[\s\S]*tool_version tlv_1/);
    expect(state.deletes).toEqual([]);
  });

  it("asks nothing about switches when the listing has no mcp servers", async () => {
    serverRows = [];
    const result = await handler({ orgListingId: "porg-1" }, ctx as never);

    expect(result).toEqual({ ok: true });
    // Only the server read; no tool-version read and no emergency_denies read.
    expect(state.selects).toEqual([schema.mcpServers]);
    expect(state.deletes).toEqual([schema.mcpServers]);
  });

  it("reads the servers, then their tool versions, then the switches", async () => {
    await handler({ orgListingId: "porg-1" }, ctx as never);
    expect(state.selects).toEqual([
      schema.mcpServers,
      schema.toolVersions,
      schema.emergencyDenies,
    ]);
  });
});

// Witness for the role gate (#4194). The kernel's IAM check allows every
// capability for a non-enterprise org, so without the handler's
// assertContractRole call this Member would get through and the test fails.
describe("uninstall_plugin role gate", () => {
  beforeEach(() => resetRoleGate());

  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(
      handler({ orgListingId: "porg-1" }, ctx as never),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(state.selects).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.deletes).toEqual([]);
  });
});
