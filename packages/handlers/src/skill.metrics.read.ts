/**
 * skill.metrics.read handler
 *
 * OXA-1750: Aggregate skill usage metrics from two sources:
 *   1. Postgres agent.skills table — fast-path usageCount + lastUsedAt + activeVersionId
 *      (denormalised columns maintained by the skill load path).
 *   2. ClickHouse skill_loads table — per-version load counts + last-used via
 *      readSkillMetrics from @oxagen/telemetry.
 *
 * approxTokenCost note: a full token_usage join keyed on execution_step_id would
 * attribute total cost to this skill. However multi-skill agent runs load several
 * skills per step, so cost is attributed to all loaded skills. The current
 * implementation returns approxTokenCost=null (OXA-1750 phase 2 will wire the
 * ClickHouse join). Document this caveat in the contract description.
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillMetricsRead } from "@oxagen/oxagen/contracts/skill.metrics.read";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { readSkillMetrics } from "@oxagen/telemetry";
import { logger } from "./logger";

export const skillMetricsReadHandler: CapabilityHandler<typeof skillMetricsRead> = async (
  input,
  ctx,
) => {
  // ── 1. Postgres: skill identities, usageCount, lastUsedAt, activeVersionId ──

  const pgRows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.skills.publicId,
        slug: schema.skills.slug,
        usageCount: schema.skills.usageCount,
        lastUsedAt: schema.skills.lastUsedAt,
        activeVersionId: schema.skills.activeVersionId,
      })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.workspaceId, ctx.workspaceId),
          isNull(schema.skills.deletedAt),
          ...(input.skillId ? [eq(schema.skills.publicId, input.skillId)] : []),
        ),
      ),
  );

  // ── 2. Resolve activeVersionId → versionNumber in one batch query ───────────

  const activeVersionIds = pgRows
    .map((r) => r.activeVersionId)
    .filter((id): id is string => id !== null);

  const versionNumberById = new Map<string, number>();
  if (activeVersionIds.length > 0) {
    const vRows = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.skillVersions.id,
          versionNumber: schema.skillVersions.versionNumber,
        })
        .from(schema.skillVersions)
        .where(inArray(schema.skillVersions.id, activeVersionIds)),
    );
    for (const vr of vRows) {
      versionNumberById.set(vr.id, vr.versionNumber);
    }
  }

  // ── 3. ClickHouse: per-version load counts ───────────────────────────────────

  const chMetrics = await readSkillMetrics({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    skillId: input.skillId,
  }).catch((err) => {
    // Telemetry is best-effort; don't fail the read if ClickHouse is unavailable.
    logger.warn({ err, skillId: input.skillId }, "skill.metrics.read: ClickHouse unavailable");
    return null;
  });

  // Index ClickHouse per-version loads by skill publicId for O(1) lookup.
  const versionLoadsBySkillId = new Map<
    string,
    Array<{ version: number; loads: number; lastUsed: string | null }>
  >();
  if (chMetrics) {
    for (const vr of chMetrics.byVersion) {
      const existing = versionLoadsBySkillId.get(vr.skill_id) ?? [];
      existing.push({ version: vr.skill_version, loads: vr.loads, lastUsed: vr.last_used });
      versionLoadsBySkillId.set(vr.skill_id, existing);
    }
  }

  // ── 4. Assemble output ───────────────────────────────────────────────────────

  const skills = pgRows.map((r) => {
    const activeVersion =
      r.activeVersionId !== null ? (versionNumberById.get(r.activeVersionId) ?? null) : null;
    const perVersionLoads = versionLoadsBySkillId.get(r.publicId) ?? [];

    // approxTokenCost: OXA-1750 phase 2 — token_usage join not yet wired.
    const approxTokenCost: number | null = null;

    return {
      skillId: r.publicId,
      slug: r.slug,
      activeVersion,
      usageCount: r.usageCount,
      lastUsedAt: r.lastUsedAt !== null ? r.lastUsedAt.toISOString() : null,
      approxTokenCost,
      perVersionLoads,
    };
  });

  logger.info(
    {
      workspaceId: ctx.workspaceId,
      skillId: input.skillId,
      count: skills.length,
      chAvailable: chMetrics !== null,
      surface: ctx.surface,
    },
    "skill.metrics.read: returned metrics",
  );

  return { skills };
};
