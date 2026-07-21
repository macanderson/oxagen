import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler issues withTenantDb calls in a fixed order:
//   Fresh install:
//     1. existing-check  → select(...).from(...).where(...).limit(1)        → []
//     2. transaction     → insert skill .returning(); insert version .returning();
//                          update skills .set().where()                     (single tx block)
//   Idempotent (skill exists):
//     1. existing-check  → select(...).from(...).where(...).limit(1)        → [skillRow]
//     2. version lookup  → select(...).from(...).where(...).limit(1)        → [{ versionNumber }]
//
// We queue one tx-stub-builder per withTenantDb call. select-based calls share
// one builder; the transaction call gets a richer builder that resolves
// inserts/updates via dedicated spies so we can assert ordering and shapes.
const mocks = vi.hoisted(() => ({
  // results for the two possible `select(...).where(...).limit(1)` calls
  selectResults: [] as Array<() => Promise<unknown>>,
  // spies for the transaction block
  skillInsertReturning: vi.fn<() => Promise<unknown>>(),
  versionInsertReturning: vi.fn<() => Promise<unknown>>(),
  skillUpdateWhere: vi.fn<() => Promise<unknown>>(),
  insertedValues: [] as Array<Record<string, unknown>>,
  registryGet: vi.fn(),
}));

const BUILTIN_SKILL = {
  slug: "summarization",
  name: "summarization",
  description: "Summarizes documents",
  body: "## Summary skill body",
  references: [{ path: "context.md", body: "ctx" }],
  metadata: undefined,
  source: "builtin" as const,
  version: "1.0.0",
};

const CUSTOM_CONTENT = `schema_version = 1
kind = "skill"
name = "my-skill"
description = "A custom skill"
instructions = "Custom instructions"
references = []
`;

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  // Distinguish skill vs version insert by the order they happen inside the
  // single transaction block. The handler inserts the skill first, then the
  // version. We track that with a per-tx counter created fresh per call.
  const makeTx = () => {
    let insertCount = 0;
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const next = mocks.selectResults.shift();
              return next ? next() : Promise.resolve([]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: (vals: unknown) => {
          mocks.insertedValues.push(vals as Record<string, unknown>);
          insertCount += 1;
          const isSkillInsert = insertCount === 1;
          return {
            returning: () =>
              isSkillInsert
                ? mocks.skillInsertReturning()
                : mocks.versionInsertReturning(),
          };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => mocks.skillUpdateWhere(),
        }),
      }),
    };
  };

  return {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
});

// ── Skills registry mock ──────────────────────────────────────────────────────
vi.mock("@oxagen/skills", () => ({
  createBuiltinSkillRegistry: () => ({
    get: mocks.registryGet,
    list: vi.fn().mockResolvedValue([]),
    refresh: vi.fn(),
  }),
}));

import { skillWorkspaceInstallHandler } from "./skill.workspace.install";

// ── fixtures ──────────────────────────────────────────────────────────────────
const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

/** Queue the select(...).where(...).limit(1) results in call order. */
function queueSelects(...results: unknown[]): void {
  mocks.selectResults.length = 0;
  for (const r of results) {
    mocks.selectResults.push(() => Promise.resolve(r));
  }
}

describe("skillWorkspaceInstallHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertedValues.length = 0;
    // Default fresh-install path: no existing skill.
    queueSelects([]);
    mocks.skillInsertReturning.mockResolvedValue([
      { id: "uuid-skill-1", publicId: "skl_TEST01", slug: "summarization" },
    ]);
    mocks.versionInsertReturning.mockResolvedValue([
      { id: "uuid-ver-1", versionNumber: 1 },
    ]);
    mocks.skillUpdateWhere.mockResolvedValue([]);
    mocks.registryGet.mockResolvedValue(BUILTIN_SKILL);
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("throws when neither slug nor custom is provided", async () => {
    await expect(skillWorkspaceInstallHandler({}, CTX)).rejects.toThrow(
      "Either `slug` (builtin template) or `custom` must be provided",
    );
  });

  it("throws when workspaceId is missing from context", async () => {
    const noWsCtx = {
      ...CTX,
      workspaceId: undefined,
    } as unknown as CapabilityContext;
    await expect(
      skillWorkspaceInstallHandler({ slug: "summarization" }, noWsCtx),
    ).rejects.toThrow("workspaceId is required");
  });

  it("throws when builtin slug is not found in the registry", async () => {
    mocks.registryGet.mockResolvedValue(undefined);
    await expect(
      skillWorkspaceInstallHandler({ slug: "nonexistent-skill" }, CTX),
    ).rejects.toThrow('Builtin skill template "nonexistent-skill" not found');
  });

  // ── fresh install: builtin template ──────────────────────────────────────

  it("installs a builtin template and returns installed=true", async () => {
    const result = await skillWorkspaceInstallHandler(
      { slug: "summarization" },
      CTX,
    );
    expect(result.installed).toBe(true);
    expect(result.slug).toBe("summarization");
    expect(result.publicId).toBe("skl_TEST01");
    expect(result.activeVersion).toBe(1);
  });

  it("passes installedFromSlug when installing a builtin template", async () => {
    // Verify the insert was called (skill insert mock invoked)
    const result = await skillWorkspaceInstallHandler(
      { slug: "summarization" },
      CTX,
    );
    expect(result.installed).toBe(true);
    // The handler must have called registryGet with the template slug
    expect(mocks.registryGet).toHaveBeenCalledWith("summarization");
    // The skill insert must carry installedFromSlug = the template slug.
    const skillInsert = mocks.insertedValues.find(
      (v) => "installedFromSlug" in v,
    );
    expect(skillInsert).toBeDefined();
    expect(
      (skillInsert as { installedFromSlug: string }).installedFromSlug,
    ).toBe("summarization");
    // active_version_id back-fill update must have run.
    expect(mocks.skillUpdateWhere).toHaveBeenCalledTimes(1);
  });

  // ── fresh install: custom upload ──────────────────────────────────────────

  it("installs a custom skill and returns installed=true", async () => {
    mocks.skillInsertReturning.mockResolvedValueOnce([
      { id: "uuid-skill-2", publicId: "skl_CUSTOM", slug: "my-skill" },
    ]);
    const result = await skillWorkspaceInstallHandler(
      { custom: { content: CUSTOM_CONTENT } },
      CTX,
    );
    expect(result.installed).toBe(true);
    expect(result.slug).toBe("my-skill");
    expect(result.publicId).toBe("skl_CUSTOM");
    expect(result.activeVersion).toBe(1);
    // Registry should NOT be consulted for custom installs
    expect(mocks.registryGet).not.toHaveBeenCalled();
  });

  it("uses the canonical manifest name as the custom slug", async () => {
    mocks.skillInsertReturning.mockResolvedValueOnce([
      { id: "uuid-skill-3", publicId: "skl_WS", slug: "my-new-skill" },
    ]);
    const result = await skillWorkspaceInstallHandler(
      {
        custom: {
          content: CUSTOM_CONTENT.replace(
            'name = "my-skill"',
            'name = "my-new-skill"',
          ),
        },
      },
      CTX,
    );
    expect(result.slug).toBe("my-new-skill");
  });

  it("preserves an explicit display_name without changing the canonical slug", async () => {
    mocks.skillInsertReturning.mockResolvedValueOnce([
      { id: "uuid-skill-4", publicId: "skl_DISPLAY", slug: "my-skill" },
    ]);
    await skillWorkspaceInstallHandler(
      {
        custom: {
          content: `${CUSTOM_CONTENT}\n[metadata]\ndisplay_name = "My Skill"\n`,
        },
      },
      CTX,
    );

    const skillInsert = mocks.insertedValues.find((value) => "source" in value);
    expect(skillInsert).toMatchObject({ name: "My Skill", slug: "my-skill" });
  });

  // ── idempotency: skill already exists ────────────────────────────────────

  it("returns installed=false when the skill already exists", async () => {
    // call 1: existing-check → existing skill; call 2: version lookup → versionNumber 2
    queueSelects(
      [
        {
          id: "uuid-existing",
          publicId: "skl_EXISTING",
          slug: "summarization",
          activeVersionId: "uuid-ver-existing",
        },
      ],
      [{ versionNumber: 2 }],
    );

    const result = await skillWorkspaceInstallHandler(
      { slug: "summarization" },
      CTX,
    );
    expect(result.installed).toBe(false);
    expect(result.publicId).toBe("skl_EXISTING");
    expect(result.activeVersion).toBe(2);
    // No inserts on the idempotent path.
    expect(mocks.skillInsertReturning).not.toHaveBeenCalled();
    expect(mocks.versionInsertReturning).not.toHaveBeenCalled();
  });

  it("returns activeVersion=1 when existing skill has no activeVersionId", async () => {
    queueSelects([
      {
        id: "uuid-existing",
        publicId: "skl_NO_VER",
        slug: "summarization",
        activeVersionId: null,
      },
    ]);

    const result = await skillWorkspaceInstallHandler(
      { slug: "summarization" },
      CTX,
    );
    expect(result.installed).toBe(false);
    expect(result.activeVersion).toBe(1);
  });

  // ── concurrency: lost insert race ────────────────────────────────────────

  it("returns idempotent installed=false when the insert loses a unique-violation race", async () => {
    // existence check (call 1) sees nothing → proceeds to insert;
    // insert throws 23505; catch re-reads: existence check (call 2) now sees the
    // row a concurrent caller inserted, then version lookup (call 3).
    queueSelects(
      [],
      [
        {
          id: "uuid-race",
          publicId: "skl_RACE",
          slug: "summarization",
          activeVersionId: "uuid-ver-race",
        },
      ],
      [{ versionNumber: 1 }],
    );
    mocks.skillInsertReturning.mockRejectedValueOnce({ code: "23505" });

    const result = await skillWorkspaceInstallHandler(
      { slug: "summarization" },
      CTX,
    );
    expect(result.installed).toBe(false);
    expect(result.publicId).toBe("skl_RACE");
    expect(result.slug).toBe("summarization");
    expect(result.activeVersion).toBe(1);
  });

  it("rethrows non-unique-violation insert errors", async () => {
    mocks.skillInsertReturning.mockRejectedValueOnce(
      new Error("connection reset"),
    );
    await expect(
      skillWorkspaceInstallHandler({ slug: "summarization" }, CTX),
    ).rejects.toThrow("connection reset");
  });

  // ── output shape compliance ────────────────────────────────────────────────

  it("output always includes publicId, slug, activeVersion, installed", async () => {
    const result = await skillWorkspaceInstallHandler(
      { slug: "summarization" },
      CTX,
    );
    expect(result).toHaveProperty("publicId");
    expect(result).toHaveProperty("slug");
    expect(result).toHaveProperty("activeVersion");
    expect(result).toHaveProperty("installed");
  });
});
