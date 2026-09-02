// plugin.handlers.test.ts — handler invocation tests for all plugin-domain tools.
//
// Pattern: vi.mock the kernel `invoke` and context seam `buildContext`.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

// ── plugin.catalog.browse ─────────────────────────────────────────────────────

import handler_pluginCatalogBrowse, {
  schema as pluginCatalogBrowseSchema,
  metadata as pluginCatalogBrowseMetadata,
} from "./plugin.catalog.browse";

describe("plugin.catalog.browse handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginCatalogBrowseSchema).toBeDefined();
    expect(pluginCatalogBrowseMetadata.name).toBe("browse_plugin_catalog");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = { servers: [], nextOffset: null, total: 0 };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      limit: 30,
      offset: 0,
      search: undefined,
      categories: undefined,
      transportTypes: undefined,
      authKind: undefined,
      installed: undefined,
      pluginType: undefined,
    };
    const result = await handler_pluginCatalogBrowse(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "browse_plugin_catalog",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ servers: [], total: 0 });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("catalog unavailable"));
    await expect(
      handler_pluginCatalogBrowse({
        limit: 10,
        offset: 0,
        search: undefined,
        categories: undefined,
        transportTypes: undefined,
        authKind: undefined,
        installed: undefined,
        pluginType: undefined,
      }),
    ).rejects.toThrow("catalog unavailable");
  });
});

// ── plugin.catalog.get ────────────────────────────────────────────────────────

import handler_pluginCatalogGet, {
  schema as pluginCatalogGetSchema,
  metadata as pluginCatalogGetMetadata,
} from "./plugin.catalog.get";

describe("plugin.catalog.get handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginCatalogGetSchema).toBeDefined();
    expect(pluginCatalogGetMetadata.name).toBe("get_catalog_plugin");
  });

  it("calls invoke with catalog get args", async () => {
    const fakeOutput = {
      name: "@test/my-plugin",
      title: null,
      description: "Test plugin",
      version: "1.0.0",
      repository: null,
      websiteUrl: null,
      icons: [],
      packages: [],
      remotes: [],
      transportTypes: ["streamable-http"],
      authKind: "none",
      categories: [],
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { name: "@test/my-plugin", version: "latest" };
    await handler_pluginCatalogGet(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_catalog_plugin",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.credential.reauth ──────────────────────────────────────────────────

import handler_pluginCredentialReauth, {
  schema as pluginCredentialReauthSchema,
  metadata as pluginCredentialReauthMetadata,
} from "./plugin.credential.reauth";

describe("plugin.credential.reauth handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginCredentialReauthSchema).toBeDefined();
    expect(pluginCredentialReauthMetadata.name).toBe(
      "reauth_plugin_credential",
    );
  });

  it("calls invoke with reauth args", async () => {
    const fakeOutput = { authorizeUrl: "https://oauth.example.com/auth" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { orgListingId: "orl_1" };
    await handler_pluginCredentialReauth(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "reauth_plugin_credential",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.credential.revoke ──────────────────────────────────────────────────

import handler_pluginCredentialRevoke, {
  schema as pluginCredentialRevokeSchema,
  metadata as pluginCredentialRevokeMetadata,
} from "./plugin.credential.revoke";

describe("plugin.credential.revoke handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginCredentialRevokeSchema).toBeDefined();
    expect(pluginCredentialRevokeMetadata.name).toBe(
      "revoke_plugin_credential",
    );
  });

  it("is annotated as a destructive, idempotent, non-read-only tool", () => {
    expect(pluginCredentialRevokeMetadata.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it("calls invoke with revoke args", async () => {
    const fakeOutput = { revoked: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { orgListingId: "orl_1" };
    const result = await handler_pluginCredentialRevoke(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "revoke_plugin_credential",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual({ revoked: true });
  });
});

// ── plugin.credential.set_secret ─────────────────────────────────────────────

import handler_pluginCredentialSetSecret, {
  schema as pluginCredentialSetSecretSchema,
  metadata as pluginCredentialSetSecretMetadata,
} from "./plugin.credential.set_secret";

describe("plugin.credential.set_secret handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginCredentialSetSecretSchema).toBeDefined();
    expect(pluginCredentialSetSecretMetadata.name).toBe("set_plugin_secret");
  });

  it("calls invoke with set_secret args", async () => {
    const fakeOutput = { ok: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      orgListingId: "orl_1",
      authKind: "secret" as const,
      secret: "my-api-key" as string | undefined,
      accessToken: undefined,
      refreshToken: undefined,
    };
    await handler_pluginCredentialSetSecret(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_plugin_secret",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.org.install ────────────────────────────────────────────────────────

import handler_pluginOrgInstall, {
  schema as pluginOrgInstallSchema,
  metadata as pluginOrgInstallMetadata,
} from "./plugin.org.install";

describe("plugin.org.install handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginOrgInstallSchema).toBeDefined();
    expect(pluginOrgInstallMetadata.name).toBe("install_plugin");
  });

  it("calls invoke with install args", async () => {
    const fakeOutput = { orgListingId: "orl_1", authKind: "none" as const };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      pluginType: "mcp_server" as const,
      pluginId: undefined,
      catalogServerId: "cat_1" as string | undefined,
      custom: undefined,
      workspaceId: undefined,
    };
    await handler_pluginOrgInstall(args);

    expect(mocks.invoke).toHaveBeenCalledWith("install_plugin", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── plugin.org.install_bulk ───────────────────────────────────────────────────

import handler_pluginOrgInstallBulk, {
  schema as pluginOrgInstallBulkSchema,
  metadata as pluginOrgInstallBulkMetadata,
} from "./plugin.org.install_bulk";

describe("plugin.org.install_bulk handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginOrgInstallBulkSchema).toBeDefined();
    expect(pluginOrgInstallBulkMetadata.name).toBe("install_plugins_bulk");
  });

  it("calls invoke with bulk install args", async () => {
    const fakeOutput = { installed: [] };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      items: [
        {
          pluginType: "mcp_server" as const,
          pluginId: undefined,
          catalogServerId: "cat_1",
        },
      ],
    };
    await handler_pluginOrgInstallBulk(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "install_plugins_bulk",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.org.list ───────────────────────────────────────────────────────────

import handler_pluginOrgList, {
  schema as pluginOrgListSchema,
  metadata as pluginOrgListMetadata,
} from "./plugin.org.list";

describe("plugin.org.list handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginOrgListSchema).toBeDefined();
    expect(pluginOrgListMetadata.name).toBe("list_plugins");
  });

  it("calls invoke with org list args", async () => {
    const fakeOutput = { listings: [], denylist: [] };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { pluginType: "mcp_server" as const };
    await handler_pluginOrgList(args);

    expect(mocks.invoke).toHaveBeenCalledWith("list_plugins", args, fakeCtx, {
      surface: "mcp",
    });
  });

  it("works with empty args", async () => {
    mocks.invoke.mockResolvedValue({ listings: [], denylist: [] });
    await handler_pluginOrgList({ pluginType: undefined });
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
});

// ── plugin.set_enabled (scope-parameterised: org | workspace) ────────────────

import handler_pluginSetEnabled, {
  schema as pluginSetEnabledSchema,
  metadata as pluginSetEnabledMetadata,
} from "./plugin.set_enabled";

describe("plugin.set_enabled handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginSetEnabledSchema).toBeDefined();
    expect(pluginSetEnabledMetadata.name).toBe("set_plugin_enabled");
  });

  it("calls invoke with scope='org' args", async () => {
    const fakeOutput = { ok: true, workspaceServerId: null };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      scope: "org" as const,
      orgListingId: "orl_1",
      enabled: true,
    };
    await handler_pluginSetEnabled(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_plugin_enabled",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("calls invoke with scope='workspace' args", async () => {
    const fakeOutput = { ok: true, workspaceServerId: "wss_1" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      scope: "workspace" as const,
      orgListingId: "orl_1",
      enabled: true,
    };
    await handler_pluginSetEnabled(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_plugin_enabled",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.org.uninstall ──────────────────────────────────────────────────────

import handler_pluginOrgUninstall, {
  schema as pluginOrgUninstallSchema,
  metadata as pluginOrgUninstallMetadata,
} from "./plugin.org.uninstall";

describe("plugin.org.uninstall handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginOrgUninstallSchema).toBeDefined();
    expect(pluginOrgUninstallMetadata.name).toBe("uninstall_plugin");
  });

  it("calls invoke with uninstall args", async () => {
    const fakeOutput = { ok: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { orgListingId: "orl_1" };
    await handler_pluginOrgUninstall(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "uninstall_plugin",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.registry.add ───────────────────────────────────────────────────────

import handler_pluginRegistryAdd, {
  schema as pluginRegistryAddSchema,
  metadata as pluginRegistryAddMetadata,
} from "./plugin.registry.add";

describe("plugin.registry.add handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginRegistryAddSchema).toBeDefined();
    expect(pluginRegistryAddMetadata.name).toBe("add_plugin_registry");
  });

  it("calls invoke with registry add args", async () => {
    const fakeOutput = { registryId: "reg_1", isDefault: false };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      name: "My Registry",
      baseUrl: "https://registry.example.com",
    };
    await handler_pluginRegistryAdd(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "add_plugin_registry",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.registry.list ──────────────────────────────────────────────────────

import handler_pluginRegistryList, {
  schema as pluginRegistryListSchema,
  metadata as pluginRegistryListMetadata,
} from "./plugin.registry.list";

describe("plugin.registry.list handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginRegistryListSchema).toBeDefined();
    expect(pluginRegistryListMetadata.name).toBe("list_plugin_registries");
  });

  it("calls invoke with empty args for list", async () => {
    const fakeOutput = { registries: [] };
    mocks.invoke.mockResolvedValue(fakeOutput);

    await handler_pluginRegistryList({});

    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_plugin_registries",
      {},
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.registry.remove ────────────────────────────────────────────────────

import handler_pluginRegistryRemove, {
  schema as pluginRegistryRemoveSchema,
  metadata as pluginRegistryRemoveMetadata,
} from "./plugin.registry.remove";

describe("plugin.registry.remove handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginRegistryRemoveSchema).toBeDefined();
    expect(pluginRegistryRemoveMetadata.name).toBe("remove_plugin_registry");
  });

  it("calls invoke with registry remove args", async () => {
    const fakeOutput = { ok: true, promotedId: null };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { registryId: "reg_1" };
    await handler_pluginRegistryRemove(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "remove_plugin_registry",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── plugin.settings.set_auth_alerts ──────────────────────────────────────────

import handler_pluginSettingsSetAuthAlerts, {
  schema as pluginSettingsSetAuthAlertsSchema,
  metadata as pluginSettingsSetAuthAlertsMetadata,
} from "./plugin.settings.set_auth_alerts";

describe("plugin.settings.set_auth_alerts handler", () => {
  it("exports schema and metadata", () => {
    expect(pluginSettingsSetAuthAlertsSchema).toBeDefined();
    expect(pluginSettingsSetAuthAlertsMetadata.name).toBe("set_auth_alerts");
  });

  it("calls invoke with auth alert settings args", async () => {
    const fakeOutput = { ok: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      sendEmail: true,
      roles: ["Owner" as const, "Admin" as const],
    };
    await handler_pluginSettingsSetAuthAlerts(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_auth_alerts",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
