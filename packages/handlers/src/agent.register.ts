// agent.register.ts — mint an agent identity (MC spec §6.2, #2956).
//
// Flow, one tenant-scoped transaction after the guards:
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29), for the
//      signed-in user or the creator of the API key (resolveActingUserId).
//      The credential records that user as its creator and the principal
//      acts for them; a call with no acting user is refused.
//   2. The `agent.agents` row (status draft, deployment inactive, harness as
//      given), its delegated `iam.principals` row (kind agent, acting for the
//      registering user), the default agent role when the org has it seeded,
//      and the long-lived credential. No version row: the definition is a
//      file in git, written by `commit_agent_definition`.
//   3. One security event for the key, and the secret returned once.
import {
  schema,
  withTenantDb,
  withTransactionOrgScope,
  type Tx,
  isUniqueViolation,
} from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { agentKeysFor } from "@oxagen/agent/handlers/_agent-identity";
import { DEFAULT_AGENT_ROLE_NAME } from "@oxagen/agent/handlers/_agent-role";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { and, eq } from "drizzle-orm";
import {
  mintAgentCredential,
  requireAgentIdentity,
} from "./lib/agent-identity";
import { logger } from "./logger";

export const AGENT_IDENTITY_ROLES = ["Owner", "Admin"] as const;

export const agentRegisterHandler: CapabilityHandler<
  typeof agentRegister
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: [...AGENT_IDENTITY_ROLES] },
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const now = new Date();
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    let agent: { id: string; publicId: string; slug: string } | undefined;
    try {
      [agent] = await tx
        .insert(schema.agents)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          agentType: "custom",
          harness: input.harness,
          status: "draft",
          deploymentStatus: "inactive",
          createdById: userId,
          updatedById: userId,
        })
        .returning({
          id: schema.agents.id,
          publicId: schema.agents.publicId,
          slug: schema.agents.slug,
        });
    } catch (err) {
      // The workspace-slug index covers soft-deleted rows too: a slug is
      // reserved for good (ADR-024), so the refusal names the slug.
      if (isUniqueViolation(err)) {
        throw new HandlerError({
          code: "conflict",
          reason: "agent_slug_taken",
          message: `Slug "${input.slug}" is already used in this workspace`,
        });
      }
      throw err;
    }
    if (!agent) throw new Error("agents insert returned no row");

    const [principal] = await tx
      .insert(schema.principals)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        kind: "agent",
        displayName: input.name,
        parentUserId: userId,
      })
      .returning({
        id: schema.principals.id,
        publicId: schema.principals.publicId,
      });
    if (!principal) throw new Error("principals insert returned no row");
    await tx
      .update(schema.agents)
      .set({ principalId: principal.id })
      .where(eq(schema.agents.id, agent.id));

    const [defaultRole] = await tx
      .select({ id: schema.roles.id, scopeKind: schema.roles.scopeKind })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.orgId, ctx.orgId),
          eq(schema.roles.name, DEFAULT_AGENT_ROLE_NAME),
        ),
      )
      .limit(1);
    if (defaultRole) {
      const assign = (tx: Tx) =>
        tx
          .insert(schema.principalRoleAssignments)
          .values({
            principalId: principal.id,
            roleId: defaultRole.id,
            orgId: ctx.orgId,
            workspaceId:
              defaultRole.scopeKind === "workspace" ? ctx.workspaceId : null,
            assignedBy: userId,
            createdById: userId,
            updatedById: userId,
          })
          .onConflictDoNothing();
      if (defaultRole.scopeKind === "workspace") await assign(tx);
      else await withTransactionOrgScope(tx, assign);
    } else {
      logger.warn(
        { orgId: ctx.orgId, agentId: agent.publicId },
        `agent.register: default agent role "${DEFAULT_AGENT_ROLE_NAME}" is not seeded in this org; no role assigned (run pnpm db:seed-iam)`,
      );
    }

    const identity = await requireAgentIdentity(tx, agent.publicId, scope);
    const credential = await mintAgentCredential(tx, {
      ...scope,
      userId,
      agent: identity,
      validityDays: input.validityDays,
      now,
    });
    const agentKey =
      (await agentKeysFor(tx, scope, [identity])).get(identity.id) ?? null;
    return {
      agent,
      principalPublicId: principal.publicId,
      credential,
      agentKey,
    };
  });

  for (const eventType of ["agent.registered", "api_key.created"] as const) {
    emitSecurityEvent({
      eventType,
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: agentRegister.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
  }
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: result.agent.publicId,
      harness: input.harness,
    },
    "agent.register: identity registered",
  );

  return {
    agentId: result.agent.publicId,
    slug: result.agent.slug,
    agentKey: result.agentKey,
    principalId: result.principalPublicId,
    credential: {
      id: result.credential.publicId,
      secret: result.credential.secret,
      expiresAt: result.credential.expiresAt.toISOString(),
    },
  };
};
