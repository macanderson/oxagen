/**
 * skill-workspace-seed — idempotent default skill seeder for new workspaces.
 *
 * Every new workspace gets workspace-owned editable copies of all builtin skill
 * templates so that agents can immediately invoke them without a separate install
 * step.  Each copy is inserted as an agent.skills row (source='tenant',
 * installed_from_slug=<template slug>) plus a corresponding skill_versions v1
 * row with active_version_id back-filled.
 *
 * Identity is anchored to (workspace_id, slug) — the unique index on the skills
 * table — so repeated calls are fully idempotent: existing slugs are skipped via
 * ON CONFLICT DO NOTHING.
 *
 * Called inside (or immediately after) the workspace-creation transaction —
 * mirrors the pattern used by workspace-capability-seed and workspace-registry-seed.
 */

import { schema, withTenantDb, withSystemDb } from "@oxagen/database";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";
import { canonicalSkillMetadata } from "./skill-artifact";
import type { Tx } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createBuiltinSkillRegistry } from "@oxagen/skills";
import { logger } from "./logger";
import { skillBodyChecksum } from "./skill-checksum";

// Builtin skills are resolved from EMBEDDED module data (createBuiltinSkillRegistry),
// never a runtime filesystem read. Serverless bundlers drop the sibling
// packages/skills/skills data, so a `readdir` there returns ENOENT in prod and
// silently seeded ZERO skills — the root cause of the "no builtin on disk" error.

interface SeedArgs {
  orgId: string;
  workspaceId: string;
  /** Pass an in-flight transaction to participate in the caller's transaction. */
  tx?: Tx;
}

export interface SeedWorkspaceSkillsResult {
  /** Number of template files scanned. */
  scanned: number;
  /** Number of new skill rows inserted (0 on a re-run — idempotent). */
  inserted: number;
}

async function runSeed(
  tx: Tx,
  orgId: string,
  workspaceId: string,
): Promise<SeedWorkspaceSkillsResult> {
  const registry = createBuiltinSkillRegistry();
  const templates = await registry.list();

  let inserted = 0;

  for (const template of templates) {
    const content = serializeArtifactToml({
      schema_version: 1,
      kind: "skill",
      name: template.slug,
      description: template.description,
      instructions: template.body,
      references: template.references.map((reference) => reference.path),
      ...(canonicalSkillMetadata(template.metadata)
        ? { metadata: canonicalSkillMetadata(template.metadata) }
        : {}),
    });
    // ── Idempotency check ─────────────────────────────────────────────────
    // Skip if a skill with this slug already exists (not soft-deleted) for
    // the workspace.  ON CONFLICT DO NOTHING on the insert also guards this
    // at the DB level, but the explicit check avoids a wasted version insert.
    const existing = await tx
      .select({ id: schema.skills.id })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.orgId, orgId),
          eq(schema.skills.workspaceId, workspaceId),
          eq(schema.skills.slug, template.slug),
          isNull(schema.skills.deletedAt),
        ),
      )
      .limit(1);

    if (existing[0]) {
      logger.debug(
        { slug: template.slug, orgId, workspaceId },
        "skill-workspace-seed: skill already exists, skipping",
      );
      continue;
    }

    // ── Insert the skill identity row ─────────────────────────────────────
    const skillRows = await tx
      .insert(schema.skills)
      .values({
        orgId,
        workspaceId,
        name: template.name,
        slug: template.slug,
        description: template.description || null,
        source: "tenant",
        enabled: true,
        installedFromSlug: template.slug,
      })
      .onConflictDoNothing()
      .returning({
        id: schema.skills.id,
        publicId: schema.skills.publicId,
        slug: schema.skills.slug,
      });

    const skillRow = skillRows[0];
    if (!skillRow) {
      // Conflict on insert — row was concurrently inserted; skip gracefully.
      logger.debug(
        { slug: template.slug, orgId, workspaceId },
        "skill-workspace-seed: concurrent insert detected, skipping",
      );
      continue;
    }

    // ── Insert skill version v1 ───────────────────────────────────────────
    const versionRows = await tx
      .insert(schema.skillVersions)
      .values({
        orgId,
        workspaceId,
        skillId: skillRow.id,
        versionNumber: 1,
        isLatest: true,
        body: content,
        checksum: skillBodyChecksum(content),
        referencesPayload: template.references.map((r) => ({
          path: r.path,
          body: r.body,
        })),
      })
      .onConflictDoNothing()
      .returning({
        id: schema.skillVersions.id,
        versionNumber: schema.skillVersions.versionNumber,
      });

    const versionRow = versionRows[0];
    if (!versionRow) {
      // Should not happen given the skill row was just inserted.
      logger.warn(
        { slug: template.slug, skillId: skillRow.id, orgId, workspaceId },
        "skill-workspace-seed: version insert conflict — skipping active_version_id back-fill",
      );
      continue;
    }

    // ── Back-fill active_version_id ───────────────────────────────────────
    await tx
      .update(schema.skills)
      .set({
        activeVersionId: versionRow.id,
        activatedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.skills.id, skillRow.id));

    logger.info(
      { slug: template.slug, publicId: skillRow.publicId, orgId, workspaceId },
      "skill-workspace-seed: skill seeded",
    );

    inserted++;
  }

  logger.info(
    { scanned: templates.length, inserted, orgId, workspaceId },
    "skill-workspace-seed: seed complete",
  );

  return { scanned: templates.length, inserted };
}

/**
 * Idempotently seeds workspace-owned copies of all builtin skill templates.
 *
 * - Loads every canonical skill.toml bundle from embedded module data.
 * - Skips slugs that already exist for the workspace (idempotent).
 * - Inserts a skills row (source='tenant', installed_from_slug=<template slug>)
 *   and a skill_versions v1 row, then back-fills active_version_id.
 * - Returns `{ scanned, inserted }` — counts are informational; callers should
 *   not rely on `inserted` being non-zero after the first seeding.
 *
 * Pass `tx` to run inside a caller-owned transaction (e.g. workspace creation),
 * or omit to open a fresh `withTenantDb` session.
 */
export async function seedWorkspaceDefaultSkills({
  orgId,
  workspaceId,
  tx: callerTx,
}: SeedArgs): Promise<SeedWorkspaceSkillsResult> {
  if (callerTx) {
    return runSeed(callerTx, orgId, workspaceId);
  }
  return withTenantDb((tx) => runSeed(tx, orgId, workspaceId));
}

/**
 * Variant of `seedWorkspaceDefaultSkills` that opens a `withSystemDb`
 * (RLS-bypassing) session instead of `withTenantDb`.
 *
 * Use this from Server Actions and backfill scripts where there is no ALS
 * tenant scope — `withTenantDb` throws `TenantScopeError` in those contexts
 * because the ALS key (org_id / workspace_id) is not set.
 *
 * The original `seedWorkspaceDefaultSkills` (tenant variant) is preserved
 * intact because it is called by handlers that already run inside an ALS scope.
 */
export async function seedWorkspaceDefaultSkillsSystem({
  orgId,
  workspaceId,
}: Omit<SeedArgs, "tx">): Promise<SeedWorkspaceSkillsResult> {
  return withSystemDb((tx) => runSeed(tx, orgId, workspaceId));
}
