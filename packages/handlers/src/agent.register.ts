// agent.register.ts — mint an agent: one operator on one runtime with one
// harness, carrying a toolbelt (ADR-192, #4369; MC spec §6.2).
//
// Flow, one tenant-scoped transaction after the guards:
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29), for the
//      signed-in user or the creator of the API key (resolveActingUserId).
//      The credential records that user as its creator and the principal
//      acts for them, so that user is the agent's operator. A call with no
//      acting user is refused.
//   2. The runtime and the toolbelt the input names, the workspace's All
//      tools belt when it names none. A live agent that already runs the
//      harness on the runtime is refused with `runtime_harness_taken`,
//      naming it; the partial unique index `agents_runtime_harness_uniq` is
//      the backstop for a race. A slug the workspace has ever used is refused
//      with `agent_slug_taken` (ADR-024).
//   3. The `agent.agents` row with its runtime and toolbelt, its delegated
//      `iam.principals` row (kind agent, acting for the registering user),
//      the default agent role when the org has it seeded, version 1
//      (`registered`), and the long-lived credential.
//   4. One security event per write, and the secret returned once.
import {
  isUniqueViolation,
  schema,
  withTenantDb,
  withTransactionOrgScope,
  type Tx,
} from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { agentKeysFor } from "@oxagen/agent/handlers/_agent-identity";
import { DEFAULT_AGENT_ROLE_NAME } from "@oxagen/agent/handlers/_agent-role";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  AGENT_SLUG_MAX,
  agentRegister,
} from "@oxagen/oxagen/contracts/agent.register";
import { slugFromName } from "@oxagen/oxagen/contracts/runtime.shared";
import { and, eq } from "drizzle-orm";
import {
  mintAgentCredential,
  requireAgentIdentity,
} from "./lib/agent-identity";
import {
  assertRuntimeHarnessFree,
  requireRuntime,
  runtimeHarnessHolder,
  runtimeHarnessTakenError,
  runtimeRefOf,
  writeAgentVersion,
} from "./lib/runtimes";
import {
  ensureAllToolsBelt,
  lockToolbeltForCarrier,
  requireToolbelt,
  toolbeltRefOf,
} from "./lib/toolbelts";
import { logger } from "./logger";

export const AGENT_IDENTITY_ROLES = ["Owner", "Admin"] as const;

function slugTaken(slug: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "agent_slug_taken",
    message: `Slug "${slug}" is already used in this workspace. A slug an agent once held stays reserved; choose another.`,
  });
}

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

  const slug = input.slug ?? slugFromName(input.name, AGENT_SLUG_MAX);
  if (slug === "") {
    throw new HandlerError({
      code: "conflict",
      reason: "agent_slug_empty",
      message:
        "The name has no letter or digit to make a slug from. Type a slug.",
    });
  }

  const now = new Date();
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    const runtime = await requireRuntime(tx, scope, input.runtimeId);
    const toolbelt =
      input.toolbeltId === undefined
        ? await ensureAllToolsBelt(tx, scope, userId)
        : await requireToolbelt(tx, scope, input.toolbeltId);
    await lockToolbeltForCarrier(tx, toolbelt);
    await assertRuntimeHarnessFree(tx, scope, runtime, input.harness);
    // The slug index is not partial: a slug a deleted agent held is taken.
    const [held] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, ctx.workspaceId),
          eq(schema.agents.slug, slug),
        ),
      )
      .limit(1);
    if (held) throw slugTaken(slug);

    let agent: { id: string; publicId: string; slug: string } | undefined;
    try {
      [agent] = await tx
        .insert(schema.agents)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          slug,
          name: input.name,
          description: input.description ?? null,
          agentType: "custom",
          harness: input.harness,
          status: "draft",
          deploymentStatus: "inactive",
          runtimeId: runtime.id,
          toolbeltId: toolbelt.id,
          createdById: userId,
          updatedById: userId,
        })
        .returning({
          id: schema.agents.id,
          publicId: schema.agents.publicId,
          slug: schema.agents.slug,
        });
    } catch (err) {
      if (isUniqueViolation(err, "agents_runtime_harness_uniq")) {
        // A registration that raced this one took the pair between the read
        // above and the insert. The holder is named on a fresh read.
        throw runtimeHarnessTakenError(
          runtime,
          input.harness,
          await runtimeHarnessHolder(
            tx,
            scope,
            runtime.id,
            input.harness,
          ).catch(() => null),
        );
      }
      if (isUniqueViolation(err)) throw slugTaken(slug);
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

    const version = await writeAgentVersion(tx, {
      agentId: agent.id,
      runtimeId: runtime.id,
      toolbeltId: toolbelt.id,
      changeKind: "registered",
      userId,
      now,
    });

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
      runtime,
      toolbelt,
      version,
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
      runtimeId: result.runtime.publicId,
      toolbeltId: result.toolbelt.publicId,
    },
    "agent.register: agent registered",
  );

  return {
    agentId: result.agent.publicId,
    slug: result.agent.slug,
    agentKey: result.agentKey,
    principalId: result.principalPublicId,
    runtime: runtimeRefOf(result.runtime),
    toolbelt: toolbeltRefOf(result.toolbelt),
    version: result.version,
    credential: {
      id: result.credential.publicId,
      secret: result.credential.secret,
      expiresAt: result.credential.expiresAt.toISOString(),
    },
  };
};
