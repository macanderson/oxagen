/**
 * actions.test.ts — unit tests for getConnectorSetupSchemaAction.
 *
 * Covers: success (invoke() returns the schema), org-membership denial,
 * workspace-membership denial, and invoke() throwing (unknown pluginId /
 * downstream failure) — must return a structured { ok: false, error }
 * rather than let the RSC page throw.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockInvoke,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockLoggerError,
  workspaceRoleRows,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockInvoke: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockLoggerError: vi.fn(),
  workspaceRoleRows: { rows: [{ role: "member" }] as Array<{ role: string }> },
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/database", () => ({
  withTenantDb: async (fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => workspaceRoleRows.rows,
          }),
        }),
      }),
    }),
  schema: {
    workspaceUsers: {
      workspaceId: "workspaceId",
      userId: "userId",
      role: "role",
    },
  },
}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

import { getConnectorSetupSchemaAction } from "./actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1" };
const WS = { id: "ws-1" };

const SCHEMA = {
  apiVersion: "oxagen.ai/v1alpha1" as const,
  kind: "ConnectorPlugin" as const,
  metadata: {
    id: "slack",
    displayName: "Slack",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
};

describe("getConnectorSetupSchemaAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRoleRows.rows = [{ role: "member" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("returns the connector schema on success", async () => {
    mockInvoke.mockResolvedValue(SCHEMA);

    const result = await getConnectorSetupSchemaAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      connectorId: "slack",
    });

    expect(result).toEqual({ ok: true, schema: SCHEMA });
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_plugin_schema",
      { pluginId: "slack" },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
        surface: "app",
      }),
      { surface: "agent" },
    );
  });

  it("denies when the caller is not a workspace member", async () => {
    workspaceRoleRows.rows = [];

    const result = await getConnectorSetupSchemaAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      connectorId: "slack",
    });

    expect(result).toEqual({
      ok: false,
      error: "You must be a workspace member to set up a connector.",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns a structured error and logs when invoke() throws (e.g. unknown pluginId)", async () => {
    mockInvoke.mockRejectedValue(new Error("Unknown plugin: bogus"));

    const result = await getConnectorSetupSchemaAction({
      orgSlug: "acme",
      workspaceSlug: "main",
      connectorId: "bogus",
    });

    expect(result).toEqual({ ok: false, error: "Unknown plugin: bogus" });
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it("propagates assertOrgMember rejection (IDOR guard) without invoking", async () => {
    mockAssertOrgMember.mockRejectedValue(new Error("not a member"));

    await expect(
      getConnectorSetupSchemaAction({
        orgSlug: "acme",
        workspaceSlug: "main",
        connectorId: "slack",
      }),
    ).rejects.toThrow("not a member");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
