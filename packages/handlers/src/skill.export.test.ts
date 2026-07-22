import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler issues two withTenantDb calls in order, each terminating at
// .limit(1): (1) skill lookup, (2) version lookup (specific / active / latest).
// We queue one result per withTenantDb call and reset per test so order never
// drifts between tests.
const mocks = vi.hoisted(() => ({
  dbCallResults: [] as Array<() => Promise<unknown>>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const queued = mocks.dbCallResults.shift();
      const resolve = (): Promise<unknown> =>
        queued ? queued() : Promise.resolve([]);
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => resolve() }),
          }),
        }),
      };
      return fn(tx);
    },
  };
});

import { skillExportHandler } from "./skill.export";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const SKILL_ROW = {
  id: "uuid-skill-1",
  slug: "my-skill",
  name: "My Skill",
  description: "A helpful skill",
  activeVersionId: "uuid-version-1",
};

const VERSION_ROW = {
  versionNumber: 2,
  body: `schema_version = 1
kind = "skill"
name = "my-skill"
description = "A helpful skill"
instructions = "Do things well."
references = []
`,
};

/** Queue the two withTenantDb results (skill lookup, version lookup). */
function enqueue(skill: unknown, version: unknown): void {
  mocks.dbCallResults.length = 0;
  mocks.dbCallResults.push(
    () => Promise.resolve(skill),
    () => Promise.resolve(version),
  );
}

describe("skillExportHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueue([SKILL_ROW], [VERSION_ROW]);
  });

  it("returns filename, content, and versionNumber for the active version", async () => {
    const result = await skillExportHandler({ skillId: "skl_abc" }, CTX);

    expect(result.filename).toBe("my-skill.toml");
    expect(result.versionNumber).toBe(2);
    expect(result.content).toContain("schema_version = 1");
    expect(result.content).toContain('name = "my-skill"');
    expect(result.content).toContain('description = "A helpful skill"');
    expect(result.content).toContain("Do things well.");
  });

  it("content round-trips through the TOML artifact parser", async () => {
    const result = await skillExportHandler({ skillId: "skl_abc" }, CTX);
    const { parseArtifactToml } = await import("@oxagen/agent-artifacts");
    expect(parseArtifactToml(result.content)).toMatchObject({
      kind: "skill",
      name: "my-skill",
      instructions: "Do things well.",
    });
  });

  it("exports a specific version when versionNumber is supplied", async () => {
    enqueue(
      [SKILL_ROW],
      [
        {
          versionNumber: 1,
          body: VERSION_ROW.body.replace("Do things well.", "Old body."),
        },
      ],
    );
    const result = await skillExportHandler(
      { skillId: "skl_abc", versionNumber: 1 },
      CTX,
    );
    expect(result.versionNumber).toBe(1);
    expect(result.content).toContain("Old body.");
  });

  it("throws when skill is not found", async () => {
    enqueue([], [VERSION_ROW]);
    await expect(
      skillExportHandler({ skillId: "skl_missing" }, CTX),
    ).rejects.toThrow("Skill not found: skl_missing");
  });

  it("throws when the requested version is not found", async () => {
    enqueue([SKILL_ROW], []);
    await expect(
      skillExportHandler({ skillId: "skl_abc", versionNumber: 99 }, CTX),
    ).rejects.toThrow("Version 99 not found for skill skl_abc");
  });

  it("throws when no version exists for the skill", async () => {
    // No activeVersionId + no is_latest row.
    enqueue([{ ...SKILL_ROW, activeVersionId: null }], []);
    await expect(
      skillExportHandler({ skillId: "skl_abc" }, CTX),
    ).rejects.toThrow("No version found for skill skl_abc");
  });

  it("uses slug as the filename stem", async () => {
    enqueue([{ ...SKILL_ROW, slug: "my-special-skill" }], [VERSION_ROW]);
    const result = await skillExportHandler({ skillId: "skl_abc" }, CTX);
    expect(result.filename).toBe("my-special-skill.toml");
  });

  it("exports the immutable content independently of mutable skill metadata", async () => {
    enqueue([{ ...SKILL_ROW, description: null }], [VERSION_ROW]);
    const result = await skillExportHandler({ skillId: "skl_abc" }, CTX);
    expect(result.content).toContain('description = "A helpful skill"');
  });

  it("propagates DB error from skill lookup", async () => {
    mocks.dbCallResults.length = 0;
    mocks.dbCallResults.push(() => Promise.reject(new Error("DB failure")));
    await expect(
      skillExportHandler({ skillId: "skl_abc" }, CTX),
    ).rejects.toThrow("DB failure");
  });

  it("propagates DB error from version lookup", async () => {
    mocks.dbCallResults.length = 0;
    mocks.dbCallResults.push(
      () => Promise.resolve([SKILL_ROW]),
      () => Promise.reject(new Error("version DB failure")),
    );
    await expect(
      skillExportHandler({ skillId: "skl_abc" }, CTX),
    ).rejects.toThrow("version DB failure");
  });
});
