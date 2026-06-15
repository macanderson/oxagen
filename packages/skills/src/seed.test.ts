import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedSkillsFromFilesystem, BUILTIN_ORG_ID, BUILTIN_WORKSPACE_ID } from "./seed";
import type { SkillSeedAdapter } from "./seed";

// ---------------------------------------------------------------------------
// Fake filesystem root that scanSkillsDir will find and load real .skill.md
// files from. The actual filesystem skills directory is at:
//   packages/skills/skills/
// resolve it relative to this test file so the test is self-contained.
// ---------------------------------------------------------------------------
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
// __filename is .../packages/skills/src/seed.test.ts
// skills dir is .../packages/skills/skills/
const SKILLS_FS_ROOT = resolve(dirname(__filename), "../skills");

// ---------------------------------------------------------------------------
// Fake adapter factory
// ---------------------------------------------------------------------------

interface FakeStore {
  skills: Map<string, { id: string; slug: string; workspaceId: string }>;
  skillVersions: Map<string, { skillId: string; versionNumber: number }>;
}

function makeFakeAdapter(store: FakeStore): SkillSeedAdapter {
  let nextId = 1;

  return {
    async upsertSkill(row) {
      const key = `${row.workspaceId}:${row.slug}`;
      if (!store.skills.has(key)) {
        store.skills.set(key, {
          id: `fake-id-${nextId++}`,
          slug: row.slug,
          workspaceId: row.workspaceId,
        });
      }
    },

    async findSkillId(workspaceId, slug) {
      return store.skills.get(`${workspaceId}:${slug}`)?.id;
    },

    async upsertSkillVersion(row) {
      const key = `${row.skillId}:${row.versionNumber}`;
      if (!store.skillVersions.has(key)) {
        store.skillVersions.set(key, {
          skillId: row.skillId,
          versionNumber: row.versionNumber,
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("seedSkillsFromFilesystem", () => {
  let store: FakeStore;
  let adapter: SkillSeedAdapter;

  beforeEach(() => {
    store = {
      skills: new Map(),
      skillVersions: new Map(),
    };
    adapter = makeFakeAdapter(store);
  });

  it("upserts all built-in skills on first run", async () => {
    const result = await seedSkillsFromFilesystem(adapter, {
      fsRoot: SKILLS_FS_ROOT,
    });

    expect(result.processed).toBe(5);

    const slugs = [...store.skills.values()].map((r) => r.slug).sort();
    expect(slugs).toEqual([
      "agent-builder",
      "coding",
      "debugging",
      "skill-builder",
      "summarization",
    ]);
  });

  it("inserts one skill_version row per skill", async () => {
    await seedSkillsFromFilesystem(adapter, { fsRoot: SKILLS_FS_ROOT });

    // Each skill gets exactly one version (version_number=1).
    expect(store.skillVersions.size).toBe(5);
    for (const v of store.skillVersions.values()) {
      expect(v.versionNumber).toBe(1);
    }
  });

  it("uses the builtin sentinel IDs for org and workspace", async () => {
    // Patch the adapter to capture the org/workspace values written.
    const orgIds: string[] = [];
    const workspaceIds: string[] = [];

    const capturingAdapter: SkillSeedAdapter = {
      async upsertSkill(row) {
        orgIds.push(row.orgId);
        workspaceIds.push(row.workspaceId);
        await adapter.upsertSkill(row);
      },
      findSkillId: adapter.findSkillId.bind(adapter),
      upsertSkillVersion: adapter.upsertSkillVersion.bind(adapter),
    };

    await seedSkillsFromFilesystem(capturingAdapter, { fsRoot: SKILLS_FS_ROOT });

    for (const orgId of orgIds) {
      expect(orgId).toBe(BUILTIN_ORG_ID);
    }
    for (const workspaceId of workspaceIds) {
      expect(workspaceId).toBe(BUILTIN_WORKSPACE_ID);
    }
  });

  it("is idempotent — a second run does not duplicate rows", async () => {
    // Track insert call counts separately from the DO NOTHING logic.
    let skillInserts = 0;
    let versionInserts = 0;

    const countingAdapter: SkillSeedAdapter = {
      async upsertSkill(row) {
        skillInserts++;
        await adapter.upsertSkill(row);
      },
      findSkillId: adapter.findSkillId.bind(adapter),
      async upsertSkillVersion(row) {
        versionInserts++;
        await adapter.upsertSkillVersion(row);
      },
    };

    // First run
    await seedSkillsFromFilesystem(countingAdapter, { fsRoot: SKILLS_FS_ROOT });

    const skillsAfterFirstRun = store.skills.size;
    const versionsAfterFirstRun = store.skillVersions.size;

    // Second run
    await seedSkillsFromFilesystem(countingAdapter, { fsRoot: SKILLS_FS_ROOT });

    // The fake adapter's DO NOTHING logic leaves Map sizes unchanged.
    expect(store.skills.size).toBe(skillsAfterFirstRun);
    expect(store.skillVersions.size).toBe(versionsAfterFirstRun);

    // The upsert methods were each called twice (once per run × 5 skills = 10
    // total for skills; adapter silently skips duplicates on the second pass).
    expect(skillInserts).toBe(10);
    expect(versionInserts).toBe(10);
  });

  it("returns the same processed count on both first and second runs", async () => {
    const first = await seedSkillsFromFilesystem(adapter, {
      fsRoot: SKILLS_FS_ROOT,
    });
    const second = await seedSkillsFromFilesystem(adapter, {
      fsRoot: SKILLS_FS_ROOT,
    });

    expect(first.processed).toBe(5);
    expect(second.processed).toBe(5);
  });

  it("skips a skill if findSkillId returns undefined", async () => {
    // Adapter that never resolves an ID — simulates a failed upsert.
    const brokenAdapter: SkillSeedAdapter = {
      async upsertSkill() {
        /* no-op */
      },
      async findSkillId() {
        return undefined;
      },
      upsertSkillVersion: vi.fn(),
    };

    const result = await seedSkillsFromFilesystem(brokenAdapter, {
      fsRoot: SKILLS_FS_ROOT,
    });

    // Still counts every file processed; just no versions were written.
    expect(result.processed).toBe(5);
    expect(brokenAdapter.upsertSkillVersion).not.toHaveBeenCalled();
  });
});
