// tacho.enrollment_token.create.ts — `create_enrollment_token` (#2967).
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29); the gate also
//      refuses a context with no user, and the token records who it was
//      issued to.
//   2. The agent: a live `agent.agents` row in this workspace, with the org
//      and workspace namespaces that make its key (ADR-024). The handler
//      refuses a retired agent with `agent_retired`, so no machine can
//      enroll as it.
//   3. The token: 26 Crockford characters behind the `oxe_1time_` prefix,
//      stored as its SHA-256, returned once with the command that uses it.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { tachoEnrollmentTokenCreate } from "@oxagen/oxagen/contracts/tacho.enrollment_token.create";
import { schema, withTenantDb } from "@oxagen/database";
import { cryptoRandom } from "@oxagen/database/schema";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq, isNull } from "drizzle-orm";
import { assertNotManaged, assertNotRetired } from "./lib/agent-identity";
import { enrollCommandFor, hashEnrollmentToken } from "./lib/onboarding";
import { logger } from "./logger";

const MINUTE_MS = 60 * 1000;
const TOKEN_PREFIX = "oxe_1time_";

const ENROLLMENT_TOKEN_ROLES = ["Owner", "Admin"] as const;

export const tachoEnrollmentTokenCreateHandler: CapabilityHandler<
  typeof tachoEnrollmentTokenCreate
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: [...ENROLLMENT_TOKEN_ROLES] },
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMinutes * MINUTE_MS);
  const token = `${TOKEN_PREFIX}${cryptoRandom(26)}`;

  const result = await withTenantDb(async (tx) => {
    const [agent] = await tx
      .select({
        id: schema.agents.id,
        publicId: schema.agents.publicId,
        slug: schema.agents.slug,
        agentType: schema.agents.agentType,
        status: schema.agents.status,
        harness: schema.agents.harness,
        orgNamespace: schema.organizations.namespace,
        workspaceNamespace: schema.workspaces.namespace,
      })
      .from(schema.agents)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.agents.orgId),
      )
      .innerJoin(
        schema.workspaces,
        eq(schema.workspaces.id, schema.agents.workspaceId),
      )
      .where(
        and(
          eq(schema.agents.orgId, ctx.orgId),
          eq(schema.agents.workspaceId, ctx.workspaceId),
          eq(schema.agents.publicId, input.agentId),
          isNull(schema.agents.deletedAt),
        ),
      )
      .limit(1);
    if (!agent) {
      throw new HandlerError({
        code: "not_found",
        reason: "agent_not_found",
        message: `No agent "${input.agentId}" in this workspace`,
      });
    }
    // No host runs the built-in assistant: stella runs inside Oxagen (#4350).
    assertNotManaged(agent);
    assertNotRetired(agent);
    const [row] = await tx
      .insert(schema.tachoEnrollmentTokens)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        agentId: agent.id,
        tokenHash: hashEnrollmentToken(token),
        issuedToUserId: userId,
        expiresAt,
        createdAt: now,
        createdById: userId,
      })
      .returning({ publicId: schema.tachoEnrollmentTokens.publicId });
    if (!row) throw new Error("enrollment_tokens insert returned no row");
    return {
      tokenId: row.publicId,
      agentId: agent.publicId,
      agentKey: `${agent.orgNamespace}.${agent.workspaceNamespace}.${agent.slug}`,
      harness: agent.harness,
    };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: result.agentId,
      tokenId: result.tokenId,
      expiresAt: expiresAt.toISOString(),
    },
    "tacho.enrollment_token.create: token issued",
  );

  return {
    tokenId: result.tokenId,
    token,
    expiresAt: expiresAt.toISOString(),
    agentId: result.agentId,
    agentKey: result.agentKey,
    enrollCommand: enrollCommandFor(token, result.harness),
  };
};
