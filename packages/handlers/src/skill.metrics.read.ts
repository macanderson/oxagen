/**
 * skill.metrics.read handler
 *
 * Aggregate skill usage metrics from two sources:
 *   1. Postgres agent.skills table — fast-path usageCount + lastUsedAt + activeVersionId
 *      (denormalised columns maintained by the skill load path).
 *   2. ClickHouse skill_loads table — per-version load counts + last-used via
 *      readSkillMetrics from @oxagen/telemetry.
 *
 * approxTokenCost: each skill's cost is the sum of
 * token_usage.cost_usd_micros over every execution step that loaded the skill,
 * joined on execution_step_id (see readSkillTokenCosts). Because a multi-skill
 * agent step loads several skills, that step's full cost is attributed to ALL of
 * them, so cross-skill sums may exceed actual spend — the contract description
 * documents this partial-attribution caveat. The value is reported in USD cents.
 * A skill with no matching token rows reports null (genuinely no cost data); a
 * ClickHouse cost-query FAILURE also reports null but is logged distinctly so the
 * two are never confused.
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillMetricsRead } from "@oxagen/oxagen/contracts/skill.metrics.read";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { readSkillMetrics, readSkillTokenCosts } from "@oxagen/telemetry";
import { logger } from "./logger";

// token_usage.cost_usd_micros is USD × 1e6; the contract reports USD cents.
// 1 cent = 10_000 micros.
const MICROS_PER_CENT = 10_000;

export const skillMetricsReadHandler: CapabilityHandler<
  typeof skillMetricsRead
> = async (input, ctx) => {
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
    logger.warn(
      { err, skillId: input.skillId },
      "skill.metrics.read: ClickHouse unavailable",
    );
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
      existing.push({
        version: vr.skill_version,
        loads: vr.loads,
        lastUsed: vr.last_used,
      });
      versionLoadsBySkillId.set(vr.skill_id, existing);
    }
  }

  // ── 3b. ClickHouse: approximate token cost per skill (USD micros) ─────────────
  //
  // Separate best-effort call from the load metrics above so a cost-query
  // failure degrades ONLY approxTokenCost (→ null) without dropping perVersion
  // loads. `costBySkillId === null` means the query failed (logged as an error);
  // a present-but-missing skill means genuinely no attributable token data.

  let costBySkillId: Map<string, number> | null = null;
  try {
    const costRows = await readSkillTokenCosts({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      skillId: input.skillId,
    });
    costBySkillId = new Map(
      costRows.map((r) => [r.skill_id, r.cost_usd_micros]),
    );
  } catch (err) {
    // Distinct from the "ClickHouse unavailable" load-metrics warning above:
    // this is specifically the token-cost join failing. Report null cost, not a
    // fabricated zero, and never fail the read.
    logger.error(
      { err, skillId: input.skillId, workspaceId: ctx.workspaceId },
      "skill.metrics.read: token-cost query failed — approxTokenCost reported as null",
    );
    costBySkillId = null;
  }

  // ── 4. Assemble output ───────────────────────────────────────────────────────

  const skills = pgRows.map((r) => {
    const activeVersion =
      r.activeVersionId !== null
        ? (versionNumberById.get(r.activeVersionId) ?? null)
        : null;
    const perVersionLoads = versionLoadsBySkillId.get(r.publicId) ?? [];

    // approxTokenCost in USD cents. null when the cost query failed
    // (costBySkillId === null) OR the skill has no attributable token rows.
    const costMicros = costBySkillId?.get(r.publicId);
    const approxTokenCost: number | null =
      costBySkillId === null || costMicros === undefined
        ? null
        : costMicros / MICROS_PER_CENT;

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
      costAvailable: costBySkillId !== null,
      surface: ctx.surface,
    },
    "skill.metrics.read: returned metrics",
  );

  return { skills };
};
