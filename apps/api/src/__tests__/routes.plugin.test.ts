/**
 * Unit tests for plugin route handlers:
 *   plugin.catalog.browse, plugin.catalog.get, plugin.catalog.sync,
 *   plugin.credential.reauth, plugin.credential.revoke,
 *   plugin.credential.set_secret,
 *   plugin.org.install, plugin.org.install_bulk, plugin.org.list,
 *   set_plugin_enabled (scope=org|workspace), plugin.org.uninstall,
 *   plugin.registry.add, plugin.registry.list, plugin.registry.remove,
 *   plugin.settings.set_auth_alerts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws";

function authHeaders() {
  return { authorization: bearerHeader("oxk_key") };
}

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── plugin.catalog.browse ─────────────────────────────────────────────────

describe("plugin.catalog.browse route", () => {
  const PATH = "/plugin/catalog/browse";

  it("happy path: 200 with results", async () => {
    const invokeResult = { plugins: [], total: 0 };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'browse_plugin_catalog'", async () => {
    await app.fetch(post(PATH, { search: "slack", limit: 10 }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("browse_plugin_catalog");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.search).toBe("slack");
    expect(body.limit).toBe(10);
  });
});

// ── plugin.catalog.get ────────────────────────────────────────────────────

describe("plugin.catalog.get route", () => {
  const PATH = "/plugin/catalog/get";

  it("happy path: 200 with catalog entry", async () => {
    const invokeResult = {
      id: "cat-1",
      name: "slack",
      title: "Slack",
      description: "Slack integration",
      version: "1.0.0",
    };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await app.fetch(post(PATH, { name: "slack" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_catalog_plugin' and name", async () => {
    await app.fetch(post(PATH, { name: "slack" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_catalog_plugin");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.name).toBe("slack");
  });

  it("missing name → 400", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── plugin.catalog.sync ───────────────────────────────────────────────────

describe("plugin.catalog.sync route", () => {
  const PATH = "/plugin/catalog/sync";

  it("happy path: 200 with sync summary", async () => {
    const invokeResult = {
      total: 3,
      succeeded: 3,
      failed: 0,
      totalEntries: 42,
      durationMs: 120,
    };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'sync_plugin_catalog' and defaults fullSync to false", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("sync_plugin_catalog");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fullSync).toBe(false);
  });

  it("forwards fullSync=true", async () => {
    await app.fetch(post(PATH, { fullSync: true }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fullSync).toBe(true);
  });
});

// ── plugin.credential.reauth ─────────────────────────────────────────────

describe("plugin.credential.reauth route", () => {
  const PATH = "/plugin/credential/reauth";

  it("happy path: 200 with authorize URL", async () => {
    mocks.invoke.mockResolvedValue({
      authorizeUrl: "https://accounts.google.com/o/oauth2/auth?...",
    });
    const res = await app.fetch(post(PATH, { orgListingId: "lst-1" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'reauth_plugin_credential'", async () => {
    await app.fetch(post(PATH, { orgListingId: "lst-2" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("reauth_plugin_credential");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.orgListingId).toBe("lst-2");
  });
});

// ── plugin.credential.revoke ─────────────────────────────────────────────

describe("plugin.credential.revoke route", () => {
  const PATH = "/plugin/credential/revoke";

  it("happy path: 200 with revoked flag", async () => {
    mocks.invoke.mockResolvedValue({ revoked: true });
    const res = await app.fetch(post(PATH, { orgListingId: "lst-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
  });

  it("calls invoke with 'revoke_plugin_credential'", async () => {
    await app.fetch(post(PATH, { orgListingId: "lst-2" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("revoke_plugin_credential");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.orgListingId).toBe("lst-2");
  });

  it("missing orgListingId → 400", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── plugin.credential.set_secret ─────────────────────────────────────────

describe("plugin.credential.set_secret route", () => {
  const PATH = "/plugin/credential/set-secret";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });
    const res = await app.fetch(
      post(PATH, {
        orgListingId: "lst-1",
        authKind: "secret",
        secret: "s3cr3t",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'set_plugin_secret'", async () => {
    await app.fetch(
      post(PATH, {
        orgListingId: "lst-1",
        authKind: "oauth",
        accessToken: "tok",
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("set_plugin_secret");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.authKind).toBe("oauth");
  });
});

// ── plugin.org.install ────────────────────────────────────────────────────

describe("plugin.org.install route", () => {
  const PATH = "/plugin/org/install";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({ orgListingId: "lst-new" });
    const res = await app.fetch(
      post(PATH, { pluginType: "agent_capability", pluginId: "srv-1" }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'install_plugin'", async () => {
    await app.fetch(
      post(PATH, { pluginType: "agent_capability", pluginId: "srv-1" }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("install_plugin");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.pluginType).toBe("agent_capability");
    expect(body.pluginId).toBe("srv-1");
  });
});

// ── plugin.org.install_bulk ───────────────────────────────────────────────

describe("plugin.org.install_bulk route", () => {
  const PATH = "/plugin/org/install-bulk";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({ installed: [], failed: [] });
    const res = await app.fetch(
      post(PATH, { items: [{ catalogServerId: "srv-1" }] }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'install_plugins_bulk'", async () => {
    await app.fetch(
      post(PATH, {
        items: [{ catalogServerId: "s1" }, { catalogServerId: "s2" }],
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("install_plugins_bulk");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("empty items array → 400", async () => {
    const res = await app.fetch(post(PATH, { items: [] }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── plugin.org.list ───────────────────────────────────────────────────────

describe("plugin.org.list route", () => {
  const PATH = "/plugin/org/list";

  it("happy path: 200 with listings", async () => {
    mocks.invoke.mockResolvedValue({ listings: [] });
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listings: [] });
  });

  it("calls invoke with 'list_plugins'", async () => {
    await app.fetch(post(PATH, { pluginType: "mcp_server" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_plugins");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.pluginType).toBe("mcp_server");
  });
});

// ── set_plugin_enabled (scope-parameterised) ──────────────────────────────

describe("set_plugin_enabled route", () => {
  const PATH = "/plugin/set-enabled";

  it("happy path: 200 (scope=org)", async () => {
    mocks.invoke.mockResolvedValue({ ok: true, workspaceServerId: null });
    const res = await app.fetch(
      post(PATH, { scope: "org", orgListingId: "lst-1", enabled: true }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'set_plugin_enabled' (scope=org)", async () => {
    await app.fetch(
      post(PATH, { scope: "org", orgListingId: "lst-1", enabled: false }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("set_plugin_enabled");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.scope).toBe("org");
    expect(body.enabled).toBe(false);
  });

  it("calls invoke with 'set_plugin_enabled' (scope=workspace)", async () => {
    mocks.invoke.mockResolvedValue({ ok: true, workspaceServerId: "ws-srv-1" });
    await app.fetch(
      post(PATH, { scope: "workspace", orgListingId: "lst-1", enabled: true }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("set_plugin_enabled");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.scope).toBe("workspace");
    expect(body.orgListingId).toBe("lst-1");
  });
});

// ── plugin.org.uninstall ──────────────────────────────────────────────────

describe("plugin.org.uninstall route", () => {
  const PATH = "/plugin/org/uninstall";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });
    const res = await app.fetch(post(PATH, { orgListingId: "lst-1" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'uninstall_plugin'", async () => {
    await app.fetch(post(PATH, { orgListingId: "lst-2" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("uninstall_plugin");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.orgListingId).toBe("lst-2");
  });
});

// ── plugin.registry.list ─────────────────────────────────────────────────

describe("plugin.registry.list route", () => {
  const PATH = "/plugin/registries";

  it("happy path: 200 with registries", async () => {
    mocks.invoke.mockResolvedValue({ registries: [] });
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registries: [] });
  });

  it("calls invoke with 'list_plugin_registries'", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_plugin_registries");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });
});

// ── plugin.registry.add ───────────────────────────────────────────────────

describe("plugin.registry.add route", () => {
  const PATH = "/plugin/registries/add";

  it("happy path: 201 with registryId", async () => {
    mocks.invoke.mockResolvedValue({ registryId: "reg-1" });
    const res = await app.fetch(
      post(PATH, {
        name: "My Registry",
        baseUrl: "https://registry.example.com",
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ registryId: "reg-1" });
  });

  it("calls invoke with 'add_plugin_registry'", async () => {
    await app.fetch(
      post(PATH, { name: "My Registry", baseUrl: "https://r.example.com" }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("add_plugin_registry");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.name).toBe("My Registry");
  });

  it("invalid baseUrl → 400", async () => {
    const res = await app.fetch(
      post(PATH, { name: "X", baseUrl: "not-a-url" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── plugin.registry.remove ────────────────────────────────────────────────

describe("plugin.registry.remove route", () => {
  const PATH = "/plugin/registries/remove";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });
    const res = await app.fetch(post(PATH, { registryId: "reg-1" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'remove_plugin_registry'", async () => {
    await app.fetch(post(PATH, { registryId: "reg-2" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("remove_plugin_registry");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.registryId).toBe("reg-2");
  });
});

// ── plugin.settings.set_auth_alerts ──────────────────────────────────────

describe("plugin.settings.set_auth_alerts route", () => {
  const PATH = "/plugin/settings/auth-alerts";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });
    const res = await app.fetch(
      post(PATH, { sendEmail: true, roles: ["Owner"] }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'set_auth_alerts'", async () => {
    await app.fetch(
      post(PATH, { sendEmail: false, roles: ["Admin", "Compliance"] }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("set_auth_alerts");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.sendEmail).toBe(false);
    expect(body.roles).toEqual(["Admin", "Compliance"]);
  });

  it("empty roles array → 400", async () => {
    const res = await app.fetch(post(PATH, { sendEmail: true, roles: [] }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
