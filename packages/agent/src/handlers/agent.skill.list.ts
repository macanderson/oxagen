import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, ilike, inArray } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type { AgentSkillListInput, AgentSkillListOutput } from "@oxagen/oxagen/contracts/agent.skill.list";
import { effectiveResourceScope } from "./_effective-scope";

export type { AgentSkillListInput, AgentSkillListOutput };

export async function agentSkillListHandler(
  input: AgentSkillListInput,
  ctx: CapabilityContext,
): Promise<AgentSkillListOutput> {
  // Single tenant-scoped query, joined to latest version. Skills shipped
  // from packages/skills are seeded with source='builtin'; tenant-authored
  // rows carry source='tenant'.
  const conditions = [
    eq(schema.skills.orgId, ctx.orgId),
    eq(schema.skills.workspaceId, ctx.workspaceId),
  ];
  if (input.filter) conditions.push(ilike(schema.skills.name, `%${input.filter}%`));

  // Agent RBAC Phase 4 (spec §3.3): the skill INDEX an agent run sees is
  // filtered to its effective skills.slugs allow-list — an unauthorized skill
  // is never even surfaced (the load-time gate in agent.skill.load is the
  // enforcement backstop; this is the UX layer of the same one resolution).
  // undefined = all enabled workspace skills; humans see everything.
  const allowedSlugs = effectiveResourceScope(ctx)?.skills?.slugs;
  if (allowedSlugs !== undefined) {
    if (allowedSlugs.length === 0) return { skills: [] };
    conditions.push(inArray(schema.skills.slug, [...allowedSlugs]));
  }

  const rows = await withTenantDb((tx) =>
    tx
      .select({
        slug: schema.skills.slug,
        name: schema.skills.name,
        description: schema.skills.description,
        source: schema.skills.source,
        version: schema.skillVersions.versionNumber,
      })
      .from(schema.skills)
      .leftJoin(
        schema.skillVersions,
        and(
          eq(schema.skillVersions.skillId, schema.skills.id),
          eq(schema.skillVersions.isLatest, true),
        ),
      )
      .where(and(...conditions)),
  );

  return {
    skills: rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description ?? "",
      source: (r.source === "tenant" ? "tenant" : "builtin") as "builtin" | "tenant",
      version: r.version != null ? String(r.version) : "1",
    })),
  };
}
