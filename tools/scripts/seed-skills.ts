#!/usr/bin/env tsx
/**
 * seed-skills.ts
 *
 * Seeds `agent.skills` + `agent.skill_versions` from the three built-in
 * *.skill.md files in packages/skills/skills/.  Runs are idempotent — a
 * second call leaves existing rows untouched via ON CONFLICT DO NOTHING.
 *
 * Run via:
 *   pnpm db:seed-skills
 *
 * Requires a running Postgres reachable at DATABASE_URL (from .env.local or
 * doppler / vercel env pull) with a previously migrated schema.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and } from "drizzle-orm";
import kleur from "kleur";
import { loadEnv } from "@oxagen/config/env";
import { db, closeDatabase } from "@oxagen/database";
import { formatError } from "./lib/format-error";
import { skills, skillVersions } from "@oxagen/database/schema";
import { seedSkillsFromFilesystem } from "@oxagen/skills";
import type { SkillSeedAdapter } from "@oxagen/skills";

// Resolve the skills directory relative to this script's location in the repo.
// __filename → tools/scripts/seed-skills.ts
// fsRoot     → packages/skills/skills
const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, "../../../");
const fsRoot = resolve(repoRoot, "packages/skills/skills");

function buildAdapter(): SkillSeedAdapter {
  const database = db();

  return {
    async upsertSkill(row) {
      await database
        .insert(skills)
        .values(row)
        .onConflictDoNothing();
    },

    async findSkillId(workspaceId, slug) {
      const rows = await database
        .select({ id: skills.id })
        .from(skills)
        .where(
          and(
            eq(skills.workspaceId, workspaceId),
            eq(skills.slug, slug),
          ),
        );
      return rows[0]?.id;
    },

    async upsertSkillVersion(row) {
      await database
        .insert(skillVersions)
        .values(row)
        .onConflictDoNothing();
    },
  };
}

async function main(): Promise<void> {
  loadEnv();

  console.log(kleur.cyan(`[seed-skills] scanning ${fsRoot}`));

  const result = await seedSkillsFromFilesystem(buildAdapter(), { fsRoot });

  console.log(
    kleur.green(`[seed-skills] done — ${result.processed} skills processed`),
  );
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(kleur.red(formatError(err)));
    process.exit(1);
  });
