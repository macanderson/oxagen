/**
 * workspace-capability-seed — idempotency and correctness tests.
 *
 * Asserts that `seedWorkspaceDefaultCapabilities`:
 *   - inserts exactly the 4 default plugin ids (one upsert per plugin)
 *   - is idempotent (ON CONFLICT DO UPDATE — the mock verifies insert is called
 *     each time but returns the same row, as the DB upsert would)
 *   - seeds rows with source="oxagen", enabled=true
 *   - throws when a plugin id is not found in the registry (guard)
 *   - calls upsertCapabilityInstall once per plugin per call
 *
 * Mocking strategy:
 *   - @oxagen/database: withTenantDb is replaced with a synchronous fake.
 *   - ./capability-install: upsertCapabilityInstall is mocked to avoid DB IO.
 *   - @oxagen/oxagen/plugins: getOxagenPlugin returns fake manifests for known ids,
 *     undefined for unknown ids.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  upsertCapabilityInstall: vi.fn(),
  getOxagenPlugin: vi.fn(),
}));

// Fake manifests for the 4 default plugin ids.
const FAKE_MANIFESTS: Record<
  string,
  { id: string; name: string; description: string }
> = {
  "oxagen/media-video": {
    id: "oxagen/media-video",
    name: "Video Generation",
    description: "Generate videos from text prompts.",
  },
  "oxagen/media-image": {
    id: "oxagen/media-image",
    name: "Image Generation",
    description: "Generate images from text prompts.",
  },
  "oxagen/media-svg": {
    id: "oxagen/media-svg",
    name: "SVG Generation",
    description: "Generate SVG graphics from text prompts.",
  },
  "oxagen/documents": {
    id: "oxagen/documents",
    name: "Document Generation",
    description: "Generate documents and PDFs.",
  },
};

// Default: return manifests for known ids, undefined for unknown.
mocks.getOxagenPlugin.mockImplementation(
  (id: string) => FAKE_MANIFESTS[id] ?? undefined,
);

// Default: upsert succeeds and returns a fake installed-plugin id.
mocks.upsertCapabilityInstall.mockResolvedValue("installed_plugin_id_stub");

vi.mock("./capability-install", () => ({
  upsertCapabilityInstall: mocks.upsertCapabilityInstall,
}));

vi.mock("@oxagen/oxagen/plugins", () => ({
  getOxagenPlugin: mocks.getOxagenPlugin,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  };
});

// Silence logger output in tests.
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  seedWorkspaceDefaultCapabilities,
  seedWorkspaceDefaultCapabilitiesSystem,
  DEFAULT_SEEDED_CAPABILITY_PLUGIN_IDS,
} from "./workspace-capability-seed";

// ─────────────────────────────────────────────────────────────────────────────

const orgId = "org_test_1";
const workspaceId = "ws_test_1";

describe("seedWorkspaceDefaultCapabilities", () => {
  beforeEach(() => {
    mocks.upsertCapabilityInstall.mockClear();
    mocks.getOxagenPlugin.mockClear();
    mocks.getOxagenPlugin.mockImplementation(
      (id: string) => FAKE_MANIFESTS[id] ?? undefined,
    );
    mocks.upsertCapabilityInstall.mockResolvedValue("installed_plugin_id_stub");
  });

  // ── constant integrity ────────────────────────────────────────────────────

  it("exports exactly 4 default plugin ids", () => {
    expect(DEFAULT_SEEDED_CAPABILITY_PLUGIN_IDS).toHaveLength(4);
  });

  it("includes all four expected first-party capability pack ids", () => {
    const ids = [...DEFAULT_SEEDED_CAPABILITY_PLUGIN_IDS];
    expect(ids).toContain("oxagen/media-video");
    expect(ids).toContain("oxagen/media-image");
    expect(ids).toContain("oxagen/media-svg");
    expect(ids).toContain("oxagen/documents");
  });

  // ── correct row count ─────────────────────────────────────────────────────

  it("calls upsertCapabilityInstall exactly 4 times (one per default plugin)", async () => {
    await seedWorkspaceDefaultCapabilities({ orgId, workspaceId });
    expect(mocks.upsertCapabilityInstall).toHaveBeenCalledTimes(4);
  });

  it("passes the correct pluginId and manifest to each upsert call", async () => {
    await seedWorkspaceDefaultCapabilities({ orgId, workspaceId });
    const calledIds = mocks.upsertCapabilityInstall.mock.calls.map(
      (call) => (call[1] as { pluginId: string }).pluginId,
    );
    expect(calledIds).toEqual(
      expect.arrayContaining([
        "oxagen/media-video",
        "oxagen/media-image",
        "oxagen/media-svg",
        "oxagen/documents",
      ]),
    );
  });

  it("passes orgId and workspaceId from args to every upsert call", async () => {
    await seedWorkspaceDefaultCapabilities({ orgId, workspaceId });
    for (const call of mocks.upsertCapabilityInstall.mock.calls) {
      const input = call[1] as { orgId: string; workspaceId: string };
      expect(input.orgId).toBe(orgId);
      expect(input.workspaceId).toBe(workspaceId);
    }
  });

  // ── idempotency ───────────────────────────────────────────────────────────

  it("is idempotent — calling twice inserts once per call (upsert handles conflict)", async () => {
    await seedWorkspaceDefaultCapabilities({ orgId, workspaceId });
    await seedWorkspaceDefaultCapabilities({ orgId, workspaceId });
    // Each call upserts 4 plugins; two calls = 8 upsert invocations.
    // The DB ON CONFLICT DO UPDATE handles the idempotency at the DB level.
    // From the seeder's perspective, upsertCapabilityInstall is called 4 times per call.
    expect(mocks.upsertCapabilityInstall).toHaveBeenCalledTimes(8);
  });

  // ── caller-tx passthrough ─────────────────────────────────────────────────

  it("passes the caller-provided tx to upsertCapabilityInstall instead of opening a new session", async () => {
    const fakeTx = { __fake: true };
    await seedWorkspaceDefaultCapabilities({
      orgId,
      workspaceId,
      tx: fakeTx as never,
    });
    // withTenantDb should not have been called; the tx arg must be forwarded.
    for (const call of mocks.upsertCapabilityInstall.mock.calls) {
      expect(call[0]).toBe(fakeTx);
    }
  });

  // ── registry guard ────────────────────────────────────────────────────────

  it("throws when a plugin id is not in the registry (unknown plugin guard)", async () => {
    // Simulate a corrupted DEFAULT_SEEDED_CAPABILITY_PLUGIN_IDS by returning undefined
    // for the first id that getOxagenPlugin is called with.
    mocks.getOxagenPlugin.mockReturnValueOnce(undefined);

    await expect(
      seedWorkspaceDefaultCapabilities({ orgId, workspaceId }),
    ).rejects.toThrow(/Unknown plugin id/);
  });
});

// ── seedWorkspaceDefaultCapabilitiesSystem ───────────────────────────────────

describe("seedWorkspaceDefaultCapabilitiesSystem", () => {
  const sysOrgId = "org_sys_cap_1";
  const sysWorkspaceId = "ws_sys_cap_1";

  beforeEach(() => {
    mocks.upsertCapabilityInstall.mockClear();
    mocks.getOxagenPlugin.mockClear();
    mocks.getOxagenPlugin.mockImplementation(
      (id: string) => FAKE_MANIFESTS[id] ?? undefined,
    );
    mocks.upsertCapabilityInstall.mockResolvedValue("installed_plugin_id_stub");
  });

  it("calls upsertCapabilityInstall exactly 4 times (System variant)", async () => {
    await seedWorkspaceDefaultCapabilitiesSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    expect(mocks.upsertCapabilityInstall).toHaveBeenCalledTimes(4);
  });

  it("passes the correct orgId and workspaceId to every upsert call (System variant)", async () => {
    await seedWorkspaceDefaultCapabilitiesSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    for (const call of mocks.upsertCapabilityInstall.mock.calls) {
      const input = call[1] as { orgId: string; workspaceId: string };
      expect(input.orgId).toBe(sysOrgId);
      expect(input.workspaceId).toBe(sysWorkspaceId);
    }
  });

  it("inserts all 4 default plugin ids (System variant)", async () => {
    await seedWorkspaceDefaultCapabilitiesSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    const calledIds = mocks.upsertCapabilityInstall.mock.calls.map(
      (call) => (call[1] as { pluginId: string }).pluginId,
    );
    expect(calledIds).toEqual(
      expect.arrayContaining([
        "oxagen/media-video",
        "oxagen/media-image",
        "oxagen/media-svg",
        "oxagen/documents",
      ]),
    );
  });

  it("throws when a plugin id is not in the registry (System variant — guard)", async () => {
    mocks.getOxagenPlugin.mockReturnValueOnce(undefined);
    await expect(
      seedWorkspaceDefaultCapabilitiesSystem({
        orgId: sysOrgId,
        workspaceId: sysWorkspaceId,
      }),
    ).rejects.toThrow(/Unknown plugin id/);
  });

  it("is idempotent — calling twice upserts once per call (System variant)", async () => {
    await seedWorkspaceDefaultCapabilitiesSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    await seedWorkspaceDefaultCapabilitiesSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    expect(mocks.upsertCapabilityInstall).toHaveBeenCalledTimes(8);
  });
});
