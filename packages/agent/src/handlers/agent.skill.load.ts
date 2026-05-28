import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types.js";

export interface AgentSkillLoadInput {
  slug: string;
  parentMessageId: string;
}

export interface AgentSkillLoadOutput {
  slug: string;
  body: string;
  references: Array<{ path: string; body: string }>;
}

export async function agentSkillLoadHandler(
  input: AgentSkillLoadInput,
  ctx: CapabilityContext,
): Promise<AgentSkillLoadOutput> {
  const [row] = await db()
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
        eq(schema.skills.tenantId, ctx.tenantId),
        eq(schema.skills.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`Skill ${input.slug} not found in workspace`);
  const refs = Array.isArray(row.references)
    ? (row.references as Array<{ path: string; body: string }>)
    : [];
  return { slug: row.slug, body: row.body, references: refs };
}
