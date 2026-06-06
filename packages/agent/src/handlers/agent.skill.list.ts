import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, ilike } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type { AgentSkillListInput, AgentSkillListOutput } from "@oxagen/oxagen/contracts/agent.skill.list";

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
