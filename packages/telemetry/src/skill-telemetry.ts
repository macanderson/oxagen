// skill-telemetry.ts
//
// OXA-1750: Skill lifecycle telemetry. Insert + read helpers for the
// `skill_loads` MergeTree table (defined in schema.sql / migration 0008).
//
// - recordSkillLoad: append one skill_loads row when a workspace skill is
//   loaded into an agent run (agent.skill.load wires the emit). Fire-and-forget
//   from the caller's perspective — telemetry must never fail the load.
// - readSkillMetrics: aggregate loads-by-skill, loads-by-version, and last_used
//   for the skill.metrics.read handler.
//
// org_id/workspace_id/skill_id are denormalized onto every row so metrics query
// in isolation without a Postgres join.

import { clickhouse } from "./clickhouse";
import type { Surface } from "./clickhouse";

/**
 * One row of the `skill_loads` table. Mirrors schema.sql exactly. Nullable
 * columns are `null` (not omitted) so the ClickHouse JSONEachRow insert sends an
 * explicit NULL rather than relying on the column DEFAULT.
 */
export interface SkillLoadRow {
  org_id: string;
  workspace_id: string;
  skill_id: string;
  skill_slug: string;
  /** Integer skill version that was loaded. */
  skill_version: number;
  /** Run step that triggered the load; NULL for standalone loads. */
  execution_step_id: string | null;
  surface: Surface;
  /** Wall-clock to load + parse the skill; NULL when the loader didn't measure. */
  load_latency_ms: number | null;
  created_at: string;
}

/**
 * Append one `skill_loads` row. Batched JSONEachRow keeps a single round-trip.
 * Callers own fire-and-forget semantics (do not await unless the load latency
 * budget allows it).
 */
export async function recordSkillLoad(row: SkillLoadRow): Promise<void> {
  await clickhouse().insert({
    table: "skill_loads",
    values: [row],
    format: "JSONEachRow",
  });
}

/** Loads aggregated per (skill_id, skill_slug). */
export interface SkillLoadCount {
  skill_id: string;
  skill_slug: string;
  loads: number;
  last_used: string | null;
}

/** Loads aggregated per (skill_id, skill_version). */
export interface SkillVersionLoadCount {
  skill_id: string;
  skill_version: number;
  loads: number;
  last_used: string | null;
}

/**
 * Aggregate skill-load telemetry for the `skill.metrics.read` handler.
 *
 * - `bySkill`: total loads + last-used per skill across all versions.
 * - `byVersion`: total loads + last-used per (skill, version).
 * - `totalLoads`: sum across the scope (and `skillId` when supplied).
 * - `lastUsed`: most-recent load timestamp across the scope.
 *
 * Always filters by `orgId` + `workspaceId`. When `skillId` is supplied the
 * result is narrowed to that single skill. The query aggregates in ClickHouse
 * so the payload is bounded regardless of load volume.
 */
export async function readSkillMetrics(args: {
  orgId: string;
  workspaceId: string;
  skillId?: string;
}): Promise<{
  bySkill: SkillLoadCount[];
  byVersion: SkillVersionLoadCount[];
  totalLoads: number;
  lastUsed: string | null;
}> {
  const ch = clickhouse();
  const skillFilter = args.skillId ? "AND skill_id = {skillId:String}" : "";
  const params: Record<string, unknown> = {
    orgId: args.orgId,
    workspaceId: args.workspaceId,
  };
  if (args.skillId) params.skillId = args.skillId;

  const bySkillResult = await ch.query({
    query: `
      SELECT
        skill_id,
        any(skill_slug) AS skill_slug,
        count() AS loads,
        max(created_at) AS last_used
      FROM skill_loads
      WHERE org_id = {orgId:String}
        AND workspace_id = {workspaceId:String}
        ${skillFilter}
      GROUP BY skill_id
      ORDER BY loads DESC
    `,
    query_params: params,
    format: "JSONEachRow",
  });
  type BySkillRaw = {
    skill_id: string;
    skill_slug: string;
    loads: string;
    last_used: string | null;
  };
  const bySkillRows = (await bySkillResult.json()) as BySkillRaw[];

  const byVersionResult = await ch.query({
    query: `
      SELECT
        skill_id,
        skill_version,
        count() AS loads,
        max(created_at) AS last_used
      FROM skill_loads
      WHERE org_id = {orgId:String}
        AND workspace_id = {workspaceId:String}
        ${skillFilter}
      GROUP BY skill_id, skill_version
      ORDER BY skill_id ASC, skill_version DESC
    `,
    query_params: params,
    format: "JSONEachRow",
  });
  type ByVersionRaw = {
    skill_id: string;
    skill_version: string;
    loads: string;
    last_used: string | null;
  };
  const byVersionRows = (await byVersionResult.json()) as ByVersionRaw[];

  const bySkill: SkillLoadCount[] = bySkillRows.map((r) => ({
    skill_id: r.skill_id,
    skill_slug: r.skill_slug,
    loads: Number(r.loads),
    last_used: r.last_used,
  }));
  const byVersion: SkillVersionLoadCount[] = byVersionRows.map((r) => ({
    skill_id: r.skill_id,
    skill_version: Number(r.skill_version),
    loads: Number(r.loads),
    last_used: r.last_used,
  }));

  const totalLoads = bySkill.reduce((sum, r) => sum + r.loads, 0);
  const lastUsed = bySkill.reduce<string | null>((latest, r) => {
    if (!r.last_used) return latest;
    if (!latest || r.last_used > latest) return r.last_used;
    return latest;
  }, null);

  return { bySkill, byVersion, totalLoads, lastUsed };
}
