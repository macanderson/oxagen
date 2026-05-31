import { createSkillRegistry } from "./registry.js";
import type { Skill } from "./types.js";

// Sentinel UUIDs for builtin skills. Builtin rows are not owned by any real
// org/workspace — they are platform-global defaults. The nil UUID makes them
// distinguishable from tenant rows without a separate boolean column.
export const BUILTIN_ORG_ID = "00000000-0000-0000-0000-000000000000";
export const BUILTIN_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

// Narrow insert/select interface so the skills package never depends on
// drizzle-orm or @oxagen/database directly.  Callers inject a thin adapter
// built from their Drizzle db instance.

export interface SkillRow {
  id: string;
  slug: string;
}

// A minimal db adapter that the seeder needs.  The real Drizzle db satisfies
// this shape; tests inject a fake.
export interface SkillSeedAdapter {
  /**
   * Insert a skill row.  Must use ON CONFLICT DO NOTHING on (workspaceId, slug).
   * Returns the id of the inserted (or existing) row.
   */
  upsertSkill(row: {
    name: string;
    slug: string;
    description: string | null;
    source: string;
    orgId: string;
    workspaceId: string;
  }): Promise<void>;

  /**
   * Look up the internal UUID of an already-inserted skill.
   */
  findSkillId(workspaceId: string, slug: string): Promise<string | undefined>;

  /**
   * Insert a skill_version row.  Must use ON CONFLICT DO NOTHING on
   * (skillId, versionNumber).
   */
  upsertSkillVersion(row: {
    skillId: string;
    versionNumber: number;
    isLatest: boolean;
    body: string;
    referencesPayload: string;
    orgId: string;
    workspaceId: string;
  }): Promise<void>;
}

export interface SeedSkillsOptions {
  // Absolute path to the directory containing *.skill.md files.
  fsRoot: string;
}

export interface SeedSkillsResult {
  seeded: number;
}

/**
 * seedSkillsFromFilesystem — idempotently upserts every *.skill.md found
 * under `opts.fsRoot` into agent.skills + agent.skill_versions.
 *
 * Identity is anchored to the (BUILTIN_WORKSPACE_ID, slug) unique index.
 * On a re-run the rows are left unchanged via ON CONFLICT DO NOTHING.
 *
 * Returns the number of skills processed.  A second run returns the same
 * count even though 0 rows are actually written.
 */
export async function seedSkillsFromFilesystem(
  adapter: SkillSeedAdapter,
  opts: SeedSkillsOptions,
): Promise<SeedSkillsResult> {
  const registry = createSkillRegistry({ fsRoot: opts.fsRoot });
  const skills: Skill[] = await registry.list();

  for (const skill of skills) {
    // 1. Upsert the logical skill row (DO NOTHING on conflict).
    await adapter.upsertSkill({
      name: skill.name,
      slug: skill.slug,
      description: skill.description ?? null,
      source: skill.source,
      orgId: BUILTIN_ORG_ID,
      workspaceId: BUILTIN_WORKSPACE_ID,
    });

    // 2. Resolve the internal UUID assigned by the DB.
    const skillId = await adapter.findSkillId(BUILTIN_WORKSPACE_ID, skill.slug);
    if (!skillId) continue;

    // 3. Upsert version 1 (DO NOTHING on conflict).
    await adapter.upsertSkillVersion({
      skillId,
      versionNumber: 1,
      isLatest: true,
      body: skill.body,
      referencesPayload: JSON.stringify(skill.references),
      orgId: BUILTIN_ORG_ID,
      workspaceId: BUILTIN_WORKSPACE_ID,
    });
  }

  return { seeded: skills.length };
}
