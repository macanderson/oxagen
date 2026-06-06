import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type { AgentSkillLoadInput, AgentSkillLoadOutput } from "@oxagen/oxagen/contracts/agent.skill.load";

export type { AgentSkillLoadInput, AgentSkillLoadOutput };

export async function agentSkillLoadHandler(
  input: AgentSkillLoadInput,
  ctx: CapabilityContext,
): Promise<AgentSkillLoadOutput> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        slug: schema.skills.slug,
        body: schema.skillVersions.body,
        references: schema.skillVersions.referencesPayload,
      })
      .from(schema.skills)
      .innerJoin(
        schema.skillVersions,
        and(
          eq(schema.skillVersions.skillId, schema.skills.id),
          eq(schema.skillVersions.isLatest, true),
        ),
      )
      .where(
        and(
          eq(schema.skills.slug, input.slug),
          eq(schema.skills.orgId, ctx.orgId),
          eq(schema.skills.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1),
  );
  if (!row) throw new Error(`Skill ${input.slug} not found in workspace`);
  const refs = Array.isArray(row.references)
    ? (row.references as Array<{ path: string; body: string }>)
    : [];
  return { slug: row.slug, body: row.body, references: refs };
}
