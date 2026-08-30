/**
 * skill-workspace-seed — idempotency and correctness tests.
 *
 * Asserts that `seedWorkspaceDefaultSkills`:
 *   - inserts one skills row + one skill_versions row per template
 *   - back-fills active_version_id after version insert
 *   - sets source='tenant' and installed_from_slug=<template slug>
 *   - is idempotent: skips slugs that already exist for the workspace
 *   - passes the caller-provided tx instead of opening a new withTenantDb session
 *   - returns correct { scanned, inserted } counts
 *
 * Mocking strategy:
 *   - @oxagen/database: withTenantDb is replaced with a synchronous fake.
 *   - @oxagen/skills: createSkillRegistry.list() returns two fake templates.
 *   - Tx operations are tracked via per-call mock functions.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Fake skill templates returned by the mocked registry ─────────────────────
const FAKE_TEMPLATES = [
  {
    slug: "summarization",
    name: "summarization",
    description: "Summarizes documents",
    body: "## Summary skill",
    references: [{ path: "context.md", body: "ctx body" }],
    metadata: undefined,
    source: "builtin" as const,
    version: "1.0.0",
  },
  {
    slug: "coding",
    name: "coding",
    description: "Writes and reviews code",
    body: "## Coding skill",
    references: [],
    metadata: undefined,
    source: "builtin" as const,
    version: "1.0.0",
  },
];

// ── Hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  registryList: vi.fn(),
  txSelect: vi.fn(),
  txInsertSkill: vi.fn(),
  txInsertVersion: vi.fn(),
  txInsertSkillReturning: vi.fn(),
  txInsertVersionReturning: vi.fn(),
  txUpdate: vi.fn(),
}));

// Default behaviour: no existing skills, successful inserts.
mocks.registryList.mockResolvedValue(FAKE_TEMPLATES);
mocks.txSelect.mockResolvedValue([]); // no existing skill
mocks.txInsertSkill.mockImplementation((_val: unknown) =>
  Promise.resolve([
    { id: "uuid-skill-stub", publicId: "skl_STUB", slug: "summarization" },
  ]),
);
mocks.txInsertVersion.mockImplementation((_val: unknown) =>
  Promise.resolve([{ id: "uuid-ver-stub", versionNumber: 1 }]),
);
mocks.txInsertSkillReturning.mockImplementation((_val: unknown) =>
  Promise.resolve([
    { id: "uuid-skill-stub", publicId: "skl_STUB", slug: "summarization" },
  ]),
);
mocks.txInsertVersionReturning.mockImplementation((_val: unknown) =>
  Promise.resolve([{ id: "uuid-ver-stub", versionNumber: 1 }]),
);
mocks.txUpdate.mockResolvedValue([]);

// ── Mock @oxagen/skills ───────────────────────────────────────────────────────
vi.mock("@oxagen/skills", () => ({
  createBuiltinSkillRegistry: () => ({
    list: mocks.registryList,
    get: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// ── Mock @oxagen/database ─────────────────────────────────────────────────────
// Build a fake Tx that tracks select/insert/update calls and routes them to the
// appropriate mock so tests can assert on each operation independently.
//
// Routing: the seeder always inserts a skill row first (values contain
// `source: "tenant"`) then — only if the skill row came back — inserts a
// version row (values contain `versionNumber`).  We discriminate by inspecting
// the values payload rather than a fragile counter so that skipped version
// inserts (concurrent-conflict path) don't corrupt the routing for subsequent
// templates.

function buildFakeTx() {
  return {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => mocks.txSelect(),
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (vals: unknown) => ({
        onConflictDoNothing: () => ({
          returning: (_shape: unknown) => {
            // Distinguish skill insert from version insert by inspecting the
            // values payload: skill rows carry `source`, version rows carry
            // `versionNumber`.
            const v = vals as Record<string, unknown>;
            if ("versionNumber" in v) {
              return mocks.txInsertVersionReturning(vals);
            }
            return mocks.txInsertSkillReturning(vals);
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: (_cond: unknown) => mocks.txUpdate(_vals),
      }),
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof buildFakeTx>) => Promise<unknown>,
    ) => fn(buildFakeTx()),
    withSystemDb: async (
      fn: (tx: ReturnType<typeof buildFakeTx>) => Promise<unknown>,
    ) => fn(buildFakeTx()),
  };
});

// Silence logger output in tests.
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  seedWorkspaceDefaultSkills,
  seedWorkspaceDefaultSkillsSystem,
} from "./skill-workspace-seed";

// ─────────────────────────────────────────────────────────────────────────────

const orgId = "org_seed_test";
const workspaceId = "ws_seed_test";

describe("seedWorkspaceDefaultSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.registryList.mockResolvedValue(FAKE_TEMPLATES);
    mocks.txSelect.mockResolvedValue([]);
    mocks.txInsertSkillReturning.mockImplementation((_val: unknown) =>
      Promise.resolve([
        { id: "uuid-skill-stub", publicId: "skl_STUB", slug: "summarization" },
      ]),
    );
    mocks.txInsertVersionReturning.mockImplementation((_val: unknown) =>
      Promise.resolve([{ id: "uuid-ver-stub", versionNumber: 1 }]),
    );
    mocks.txUpdate.mockResolvedValue([]);
  });

  // ── result shape ──────────────────────────────────────────────────────────

  it("returns { scanned, inserted } with correct scanned count", async () => {
    const result = await seedWorkspaceDefaultSkills({ orgId, workspaceId });
    expect(result.scanned).toBe(FAKE_TEMPLATES.length);
  });

  it("returns inserted equal to the number of new skill rows on first run", async () => {
    const result = await seedWorkspaceDefaultSkills({ orgId, workspaceId });
    expect(result.inserted).toBe(FAKE_TEMPLATES.length);
  });

  // ── correct rows inserted ─────────────────────────────────────────────────

  it("calls txInsertSkill once per template", async () => {
    await seedWorkspaceDefaultSkills({ orgId, workspaceId });
    expect(mocks.txInsertSkillReturning).toHaveBeenCalledTimes(
      FAKE_TEMPLATES.length,
    );
  });

  it("calls txInsertVersion once per template", async () => {
    await seedWorkspaceDefaultSkills({ orgId, workspaceId });
    expect(mocks.txInsertVersionReturning).toHaveBeenCalledTimes(
      FAKE_TEMPLATES.length,
    );
  });

  it("back-fills active_version_id via update after each version insert", async () => {
    await seedWorkspaceDefaultSkills({ orgId, workspaceId });
    // One update call per template.
    expect(mocks.txUpdate).toHaveBeenCalledTimes(FAKE_TEMPLATES.length);
    // The update must include activeVersionId.
    const firstCall = mocks.txUpdate.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(firstCall).toHaveProperty("activeVersionId", "uuid-ver-stub");
  });

  // ── idempotency ───────────────────────────────────────────────────────────

  it("skips existing skills — inserts zero rows when all slugs already exist", async () => {
    // txSelect returns an existing row for every slug.
    mocks.txSelect.mockResolvedValue([{ id: "existing-skill-uuid" }]);

    const result = await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    expect(result.inserted).toBe(0);
    expect(mocks.txInsertSkillReturning).not.toHaveBeenCalled();
    expect(mocks.txInsertVersionReturning).not.toHaveBeenCalled();
  });

  it("inserts only the missing skills when some already exist", async () => {
    // First template already exists; second does not.
    mocks.txSelect
      .mockResolvedValueOnce([{ id: "existing-uuid" }]) // summarization: exists
      .mockResolvedValue([]); // coding: missing

    const result = await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    expect(result.inserted).toBe(1);
    expect(mocks.txInsertSkillReturning).toHaveBeenCalledTimes(1);
    expect(mocks.txInsertVersionReturning).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across two sequential calls (second inserts=0)", async () => {
    // First call inserts all templates.
    await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    // Second call: all slugs now "exist".
    mocks.txSelect.mockResolvedValue([{ id: "existing-uuid" }]);
    mocks.txInsertSkillReturning.mockClear();
    mocks.txInsertVersionReturning.mockClear();
    mocks.txUpdate.mockClear();

    const result2 = await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    expect(result2.inserted).toBe(0);
    expect(mocks.txInsertSkillReturning).not.toHaveBeenCalled();
    expect(mocks.txInsertVersionReturning).not.toHaveBeenCalled();
  });

  // ── caller-tx passthrough ─────────────────────────────────────────────────

  it("uses the caller-provided tx instead of opening a new withTenantDb session", async () => {
    const fakeTx = buildFakeTx();
    const selectSpy = vi.spyOn(fakeTx, "select");

    await seedWorkspaceDefaultSkills({
      orgId,
      workspaceId,
      tx: fakeTx as never,
    });

    // The fakeTx.select should have been called directly (one per template).
    expect(selectSpy).toHaveBeenCalledTimes(FAKE_TEMPLATES.length);
  });

  // ── source + provenance fields ─────────────────────────────────────────────

  it("passes source='tenant' to the skill insert", async () => {
    await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    // Capture the values argument of the first insert call.
    const insertArg = mocks.txInsertSkillReturning.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(insertArg).toMatchObject({ source: "tenant" });
  });

  it("passes installed_from_slug equal to the template slug", async () => {
    await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    const insertArg = mocks.txInsertSkillReturning.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(insertArg).toMatchObject({
      installedFromSlug: FAKE_TEMPLATES[0]?.slug,
    });
  });

  it("passes orgId and workspaceId to every skill insert", async () => {
    await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    for (const call of mocks.txInsertSkillReturning.mock.calls) {
      const arg = call[0] as Record<string, unknown>;
      expect(arg.orgId).toBe(orgId);
      expect(arg.workspaceId).toBe(workspaceId);
    }
  });

  // ── graceful concurrent-insert handling ───────────────────────────────────

  it("skips version insert and update when skill insert returns no rows (conflict)", async () => {
    // Simulate concurrent insert winning the race — the ON CONFLICT DO NOTHING
    // returns an empty array for BOTH templates (all conflict).
    mocks.txInsertSkillReturning.mockResolvedValue([]);

    const result = await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    // Scan count is unchanged; inserted stays 0 because no rows came back.
    expect(result.scanned).toBe(FAKE_TEMPLATES.length);
    expect(result.inserted).toBe(0);
    // For each template the seeder attempted an insert but got no row back,
    // so it must not have proceeded to insert a version or update.
    expect(mocks.txInsertVersionReturning).not.toHaveBeenCalled();
    expect(mocks.txUpdate).not.toHaveBeenCalled();
  });

  it("still inserts remaining templates when only one skill conflicts on concurrent insert", async () => {
    // First template conflicts (empty return); second installs successfully.
    mocks.txInsertSkillReturning
      .mockResolvedValueOnce([]) // summarization: concurrent conflict
      .mockResolvedValueOnce([
        { id: "uuid-skill-2", publicId: "skl_CODING", slug: "coding" },
      ]);

    const result = await seedWorkspaceDefaultSkills({ orgId, workspaceId });

    expect(result.scanned).toBe(FAKE_TEMPLATES.length);
    expect(result.inserted).toBe(1);
    expect(mocks.txInsertVersionReturning).toHaveBeenCalledTimes(1);
    expect(mocks.txUpdate).toHaveBeenCalledTimes(1);
  });
});

// ── seedWorkspaceDefaultSkillsSystem ─────────────────────────────────────────

describe("seedWorkspaceDefaultSkillsSystem", () => {
  const sysOrgId = "org_sys_skill";
  const sysWorkspaceId = "ws_sys_skill";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registryList.mockResolvedValue(FAKE_TEMPLATES);
    mocks.txSelect.mockResolvedValue([]);
    mocks.txInsertSkillReturning.mockImplementation((_val: unknown) =>
      Promise.resolve([
        { id: "uuid-skill-sys", publicId: "skl_SYS", slug: "summarization" },
      ]),
    );
    mocks.txInsertVersionReturning.mockImplementation((_val: unknown) =>
      Promise.resolve([{ id: "uuid-ver-sys", versionNumber: 1 }]),
    );
    mocks.txUpdate.mockResolvedValue([]);
  });

  it("returns { scanned, inserted } with correct scanned count (System variant)", async () => {
    const result = await seedWorkspaceDefaultSkillsSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    expect(result.scanned).toBe(FAKE_TEMPLATES.length);
  });

  it("returns inserted equal to the number of new skill rows on first run (System variant)", async () => {
    const result = await seedWorkspaceDefaultSkillsSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    expect(result.inserted).toBe(FAKE_TEMPLATES.length);
  });

  it("passes orgId and workspaceId to every skill insert (System variant)", async () => {
    await seedWorkspaceDefaultSkillsSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    for (const call of mocks.txInsertSkillReturning.mock.calls) {
      const arg = call[0] as Record<string, unknown>;
      expect(arg.orgId).toBe(sysOrgId);
      expect(arg.workspaceId).toBe(sysWorkspaceId);
    }
  });

  it("is idempotent — skips existing skills (System variant)", async () => {
    mocks.txSelect.mockResolvedValue([{ id: "existing-sys-uuid" }]);
    const result = await seedWorkspaceDefaultSkillsSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    expect(result.inserted).toBe(0);
    expect(mocks.txInsertSkillReturning).not.toHaveBeenCalled();
    expect(mocks.txInsertVersionReturning).not.toHaveBeenCalled();
  });

  it("passes source='tenant' to the skill insert (System variant)", async () => {
    await seedWorkspaceDefaultSkillsSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    const insertArg = mocks.txInsertSkillReturning.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(insertArg).toMatchObject({ source: "tenant" });
  });

  it("back-fills active_version_id via update after each version insert (System variant)", async () => {
    await seedWorkspaceDefaultSkillsSystem({
      orgId: sysOrgId,
      workspaceId: sysWorkspaceId,
    });
    expect(mocks.txUpdate).toHaveBeenCalledTimes(FAKE_TEMPLATES.length);
    const firstCall = mocks.txUpdate.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(firstCall).toHaveProperty("activeVersionId", "uuid-ver-sys");
  });
});
