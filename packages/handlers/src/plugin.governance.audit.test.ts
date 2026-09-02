/**
 * SOC2 audit-trail tests for the plugin governance handlers.
 *
 * Privileged org-level plugin mutations must write a security_events row
 * (CC6.3/CC6.8) just like api-key / billing / membership mutations do. These
 * tests assert each handler emits the correct event through the consolidated
 * registry helper emitSecurityEvent — and that failures do NOT emit.
 *
 * Covered here: plugin.org.uninstall, set_plugin_enabled (org scope),
 * plugin.org.install_bulk.
 * (plugin.org.install and set_plugin_enabled workspace scope are covered in
 * their own *.capability.test.ts files.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  getOxagenPlugin: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The governance handlers run inside the tenant scope (withTenantDb); install
  // also touches withSystemDb. Mock both so the fake tx is used either way.
  return {
    ...real,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("@oxagen/oxagen/plugins", () => ({
  getOxagenPlugin: mocks.getOxagenPlugin,
}));

import { handler as uninstallHandler } from "./plugin.org.uninstall";
import { handler as setEnabledHandler } from "./plugin.set_enabled";
import { handler as installBulkHandler } from "./plugin.org.install_bulk";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

const fakeManifest = {
  id: "oxagen/media-video",
  name: "Video Generation",
  description: "Generate videos from text prompts.",
  version: "1.0.0",
  // pluginType is required (the five-type taxonomy); without it the install
  // handler rejects the manifest and every governance op fails.
  pluginType: "agent_capability" as const,
  tier: "premium",
  visibility: "ga",
  category: "media",
  icon: "clapperboard",
  contracts: ["generate_video"],
  scopes: [],
};

/**
 * Generic fluent tx mock that satisfies every Drizzle chain the governance
 * handlers use: select().from().where()[.limit()], update().set().where(),
 * delete().where(), insert().values().onConflictDoNothing()/.onConflictDoUpdate().returning().
 */
function makeTx(opts?: { listingId?: string }) {
  const rows: unknown[] = [];
  const selectWhere = () =>
    Object.assign(Promise.resolve(rows), {
      limit: () => Promise.resolve(rows),
    });
  return {
    select: () => ({ from: () => ({ where: selectWhere }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(),
        onConflictDoUpdate: () => ({
          returning: () =>
            Promise.resolve([{ id: opts?.listingId ?? "porg-1" }]),
        }),
      }),
    }),
  };
}

function mockDbOk() {
  const impl = async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx());
  mocks.withSystemDb.mockImplementation(impl);
  mocks.withTenantDb.mockImplementation(impl);
}

function mockDbFail() {
  mocks.withSystemDb.mockRejectedValue(new Error("db down"));
  mocks.withTenantDb.mockRejectedValue(new Error("db down"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── plugin.org.uninstall ─────────────────────────────────────────────────────

describe("plugin.org.uninstall — audit event", () => {
  it("emits plugin.uninstalled on success", async () => {
    mockDbOk();
    const out = (await uninstallHandler({ orgListingId: "porg-1" }, ctx)) as {
      ok: boolean;
    };
    expect(out.ok).toBe(true);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.uninstalled",
        actorUserId: "user-1",
        orgId: "org-1",
        workspaceId: "ws-1",
        capability: "uninstall_plugin",
        outcome: "success",
        requestId: "req-1",
      }),
    );
  });

  it("does NOT emit when the delete fails", async () => {
    mockDbFail();
    await expect(
      uninstallHandler({ orgListingId: "porg-1" }, ctx),
    ).rejects.toThrow("db down");
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

// ── set_plugin_enabled (scope="org") ─────────────────────────────────────────

describe("set_plugin_enabled (org scope) — audit event", () => {
  it("emits plugin.enabled_changed on success", async () => {
    mockDbOk();
    const out = (await setEnabledHandler(
      { scope: "org", orgListingId: "porg-1", enabled: false },
      ctx,
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.enabled_changed",
        actorUserId: "user-1",
        orgId: "org-1",
        workspaceId: "ws-1",
        capability: "set_plugin_enabled",
        outcome: "success",
      }),
    );
  });

  it("does NOT emit when the update fails", async () => {
    mockDbFail();
    await expect(
      setEnabledHandler(
        { scope: "org", orgListingId: "porg-1", enabled: true },
        ctx,
      ),
    ).rejects.toThrow("db down");
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

// ── plugin.org.install_bulk ──────────────────────────────────────────────────

describe("plugin.org.install_bulk — audit event", () => {
  it("emits plugin.installed once per successfully installed item", async () => {
    mockDbOk();
    mocks.getOxagenPlugin.mockReturnValue(fakeManifest);
    const out = (await installBulkHandler(
      {
        items: [
          { pluginType: "agent_capability", pluginId: "oxagen/media-video" },
          { pluginType: "agent_capability", pluginId: "oxagen/media-video" },
        ],
      },
      ctx,
    )) as {
      installed: Array<{ orgListingId: string | null; error: string | null }>;
    };
    expect(out.installed).toHaveLength(2);
    expect(out.installed.every((r) => r.error === null)).toBe(true);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(2);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.installed",
        capability: "install_plugins_bulk",
        orgId: "org-1",
        outcome: "success",
      }),
    );
  });

  it("emits only for successes when some items fail", async () => {
    mockDbOk();
    mocks.getOxagenPlugin.mockImplementation((id: string) =>
      id === "oxagen/media-video" ? fakeManifest : undefined,
    );
    const out = (await installBulkHandler(
      {
        items: [
          { pluginType: "agent_capability", pluginId: "oxagen/media-video" },
          { pluginType: "agent_capability", pluginId: "oxagen/nonexistent" },
        ],
      },
      ctx,
    )) as {
      installed: Array<{ orgListingId: string | null; error: string | null }>;
    };
    expect(out.installed.filter((r) => r.error === null)).toHaveLength(1);
    expect(out.installed.filter((r) => r.error !== null)).toHaveLength(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
  });
});
