/**
 * actions.test.ts — unit tests for the "Connect a source" wizard's server
 * actions. Covers: success (invoke() called with the right capability name +
 * input), the org/workspace role gate (assertCapabilityAccess) denying and
 * allowing via each fallback path, and invoke() throwing surfacing a
 * structured { ok: false, error } rather than throwing out of the RSC/action
 * boundary. Mirrors marketplace/integrations/[connectorId]/actions.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockInvoke,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockGetOrgRole,
  mockLoggerError,
  workspaceRoleRows,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockInvoke: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockGetOrgRole: vi.fn(),
  mockLoggerError: vi.fn(),
  workspaceRoleRows: { rows: [{ role: "owner" }] as Array<{ role: string }> },
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
  getOrgRole: mockGetOrgRole,
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

import {
  getConnectSourceSchemaAction,
  validateConnectSourceConfigAction,
  createSourceConnectionAction,
  previewSourceConnectionAction,
  suggestSourceMappingsAction,
  getSourceMappingsAction,
  confirmSourceMappingsAction,
  configureSourceIntegrationAction,
} from "./actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1" };
const WS = { id: "ws-1" };
const SLUGS = { orgSlug: "acme", workspaceSlug: "main" };

beforeEach(() => {
  vi.clearAllMocks();
  workspaceRoleRows.rows = [{ role: "owner" }];
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WS);
  mockAssertOrgMember.mockResolvedValue(undefined);
  // Not an org owner/admin by default — forces the workspace-role fallback
  // path in assertCapabilityAccess so tests exercise both branches.
  mockGetOrgRole.mockResolvedValue("member");
});

describe("getConnectSourceSchemaAction", () => {
  it("returns the schema on success (workspace member allowed)", async () => {
    workspaceRoleRows.rows = [{ role: "member" }];
    mockInvoke.mockResolvedValue({ metadata: { id: "custom-sql" } });

    const result = await getConnectSourceSchemaAction({
      ...SLUGS,
      connectorId: "custom-sql",
    });

    expect(result).toEqual({
      ok: true,
      value: { metadata: { id: "custom-sql" } },
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_plugin_schema",
      { pluginId: "custom-sql" },
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "agent" },
    );
  });

  it("allows via org role when workspace role is insufficient", async () => {
    mockGetOrgRole.mockResolvedValue("admin");
    workspaceRoleRows.rows = [];
    mockInvoke.mockResolvedValue({ metadata: { id: "custom-sql" } });

    const result = await getConnectSourceSchemaAction({
      ...SLUGS,
      connectorId: "custom-sql",
    });

    expect(result.ok).toBe(true);
  });

  it("denies when caller has neither an allowed org nor workspace role", async () => {
    workspaceRoleRows.rows = [];

    const result = await getConnectSourceSchemaAction({
      ...SLUGS,
      connectorId: "custom-sql",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "You do not have permission to connect a source in this workspace.",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns a structured error when invoke() throws", async () => {
    workspaceRoleRows.rows = [{ role: "member" }];
    mockInvoke.mockRejectedValue(new Error("Unknown plugin: bogus"));

    const result = await getConnectSourceSchemaAction({
      ...SLUGS,
      connectorId: "bogus",
    });

    expect(result).toEqual({ ok: false, error: "Unknown plugin: bogus" });
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it("propagates assertOrgMember rejection without invoking (IDOR guard)", async () => {
    mockAssertOrgMember.mockRejectedValue(new Error("not a member"));

    await expect(
      getConnectSourceSchemaAction({ ...SLUGS, connectorId: "custom-sql" }),
    ).rejects.toThrow("not a member");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("validateConnectSourceConfigAction", () => {
  it("returns validation errors from invoke()", async () => {
    workspaceRoleRows.rows = [{ role: "member" }];
    mockInvoke.mockResolvedValue({
      valid: false,
      errors: [{ field: "apiKey", message: "Required", code: "required" }],
    });

    const result = await validateConnectSourceConfigAction({
      ...SLUGS,
      connectorId: "custom-sql",
      config: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.valid).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith(
      "validate_plugin_schema",
      { pluginId: "custom-sql", authSchemeId: undefined, config: {} },
      expect.anything(),
      { surface: "agent" },
    );
  });
});

describe("createSourceConnectionAction", () => {
  const INPUT = {
    ...SLUGS,
    connectorId: "custom-sql",
    displayName: "My DB",
    connectionConfig: { pollIntervalSeconds: 900 },
    authCredential: { type: "api_key", apiKey: "secret" },
  };

  it("creates the connection on success (workspace owner allowed)", async () => {
    mockInvoke.mockResolvedValue({
      connectionId: "uuid-1",
      publicId: "con_123",
      status: "pending_setup",
      connectorId: "custom-sql",
      displayName: "My DB",
    });

    const result = await createSourceConnectionAction(INPUT);

    expect(result).toEqual({
      ok: true,
      value: {
        connectionId: "uuid-1",
        publicId: "con_123",
        status: "pending_setup",
        connectorId: "custom-sql",
        displayName: "My DB",
      },
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_connection",
      {
        connectorId: "custom-sql",
        displayName: "My DB",
        connectionConfig: { pollIntervalSeconds: 900 },
        authCredential: { type: "api_key", apiKey: "secret" },
      },
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("denies a workspace member (create_connection requires workspace owner)", async () => {
    workspaceRoleRows.rows = [{ role: "member" }];

    const result = await createSourceConnectionAction(INPUT);

    expect(result).toEqual({
      ok: false,
      error:
        "You must be a workspace owner (or org owner/admin) to connect a source.",
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("previewSourceConnectionAction", () => {
  it("returns preview record types on success", async () => {
    mockInvoke.mockResolvedValue({
      recordTypes: [
        {
          sourceRecordType: "custom",
          displayName: "Custom",
          sampleCount: 2,
          sampleFields: ["id"],
          sampleRecords: [],
        },
      ],
    });

    const result = await previewSourceConnectionAction({
      ...SLUGS,
      connectionId: "con_123",
    });

    expect(result.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "preview_connection",
      { connectionId: "con_123" },
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("surfaces the raw connector error message on failure", async () => {
    mockInvoke.mockRejectedValue(
      new Error("Connection refused: bad credentials"),
    );

    const result = await previewSourceConnectionAction({
      ...SLUGS,
      connectionId: "con_123",
    });

    expect(result).toEqual({
      ok: false,
      error: "Connection refused: bad credentials",
    });
  });
});

describe("suggestSourceMappingsAction", () => {
  it("returns suggestions on success", async () => {
    mockInvoke.mockResolvedValue({
      suggestions: [
        {
          sourceRecordType: "custom",
          suggestedEntityType: "task",
          suggestedPropertyMappings: { id: "externalId" },
          confidence: 0.8,
          reasoning: "Looks like a task record.",
        },
      ],
      suggestionIds: ["sug_1"],
    });

    const result = await suggestSourceMappingsAction({
      ...SLUGS,
      connectionId: "con_123",
      recordTypes: [
        {
          sourceRecordType: "custom",
          displayName: "Custom",
          sampleFields: ["id"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "suggest_connection_mappings",
      expect.objectContaining({ connectionId: "con_123" }),
      expect.anything(),
      { surface: "agent" },
    );
  });
});

describe("getSourceMappingsAction", () => {
  it("returns existing mappings for resume (workspace member allowed)", async () => {
    workspaceRoleRows.rows = [{ role: "member" }];
    mockInvoke.mockResolvedValue({ mappings: [] });

    const result = await getSourceMappingsAction({
      ...SLUGS,
      connectionId: "con_123",
    });

    expect(result).toEqual({ ok: true, value: { mappings: [] } });
  });
});

describe("confirmSourceMappingsAction", () => {
  it("persists and activates on success", async () => {
    mockInvoke.mockResolvedValue({
      mappingsCreated: 1,
      mappingsUpdated: 0,
      connectionStatus: "active",
    });

    const result = await confirmSourceMappingsAction({
      ...SLUGS,
      connectionId: "con_123",
      mappings: [
        {
          sourceRecordType: "custom",
          oxagenEntityType: "task",
          propertyMappings: {},
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        mappingsCreated: 1,
        mappingsUpdated: 0,
        connectionStatus: "active",
      },
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "set_connection_mappings",
      expect.objectContaining({
        connectionId: "con_123",
        activateConnection: true,
      }),
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("denies a workspace member (set_connection_mappings requires workspace owner)", async () => {
    workspaceRoleRows.rows = [{ role: "member" }];

    const result = await confirmSourceMappingsAction({
      ...SLUGS,
      connectionId: "con_123",
      mappings: [
        {
          sourceRecordType: "custom",
          oxagenEntityType: "task",
          propertyMappings: {},
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("configureSourceIntegrationAction", () => {
  it("applies advanced settings on success", async () => {
    workspaceRoleRows.rows = [{ role: "member" }];
    mockInvoke.mockResolvedValue({
      integrationId: "con_123",
      displayName: "My DB",
      syncCadence: "polling",
      updatedAt: "2026-07-12T00:00:00.000Z",
    });

    const result = await configureSourceIntegrationAction({
      ...SLUGS,
      integrationId: "con_123",
      syncCadence: "polling",
    });

    expect(result.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "configure_integration",
      { integrationId: "con_123", syncCadence: "polling" },
      expect.anything(),
      { surface: "agent" },
    );
  });
});
