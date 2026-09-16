// grant_mandate — bounded, expiring authority for a consequence, to one agent
// (MC spec §6.9 part 3, ADR-059).
//
//   1. Role gate — the org roles the workspace names for every consequence
//      tag on the mandate (assertConsequenceRole, INV-29); the satisfying
//      role is recorded as role_at_grant.
//   2. The agent's delegated principal is what the mandate binds to.
//   3. Denied by construction: every tool pattern matches a declared tool and
//      every matched version declares each limited and targeted measure.
//   4. With requestId the draft request_mandate created becomes active with
//      the granter's body; otherwise one active row is inserted.
//   5. mandate.granted is the audit row.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { mandateGrant } from "@oxagen/oxagen/contracts/mandate.grant";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import {
  assertConsequenceRole,
  loadConsequenceRoles,
} from "@oxagen/iam/mandate-role";
import {
  assertToolsDeclareMeasures,
  loadMandateRow,
  mapMandates,
  requireWorkspace,
  resolveAgent,
} from "./_mandate";
import { logger } from "./logger";

export const mandateGrantHandler: CapabilityHandler<
  typeof mandateGrant
> = async (input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "grant_mandate");
  const actingUserId = await resolveActingUserId(ctx);
  const overrides = await withTenantDb((tx) =>
    loadConsequenceRoles(tx, workspaceId),
  );
  const roleAtGrant = await assertConsequenceRole(
    ctx,
    input.consequenceTags,
    overrides,
  );

  const rows = await withTenantDb(async (tx) => {
    const agent = await resolveAgent(tx, workspaceId, input.agentId);
    await assertToolsDeclareMeasures(tx, workspaceId, input);
    const body = {
      agentPrincipalId: agent.principalId,
      consequenceTags: input.consequenceTags,
      limits: input.limits,
      targets: input.targets,
      tools: input.tools,
      approvalRules: input.approval,
      purpose: input.purpose,
      validFrom: new Date(input.validFrom),
      validTo: new Date(input.validTo),
      grantedBy: actingUserId,
      roleAtGrant,
      status: "active" as const,
      updatedAt: new Date(),
      updatedByUserId: actingUserId ?? undefined,
    };
    if (input.requestId !== undefined) {
      const draft = await loadMandateRow(tx, workspaceId, input.requestId);
      if (draft.status !== "draft") {
        throw new HandlerError({
          code: "conflict",
          reason: "not_a_draft",
          message: `Mandate ${input.requestId} is ${draft.status}; only a draft can be granted`,
        });
      }
      return tx
        .update(schema.mandates)
        .set(body)
        .where(
          and(
            eq(schema.mandates.id, draft.id),
            eq(schema.mandates.status, "draft"),
          ),
        )
        .returning();
    }
    return tx
      .insert(schema.mandates)
      .values({
        ...body,
        orgId: ctx.orgId,
        workspaceId,
        createdByUserId: actingUserId ?? undefined,
      })
      .returning();
  });
  const row = rows[0];
  if (!row) {
    throw new HandlerError({
      code: "conflict",
      reason: "not_a_draft",
      message: "The draft was granted or revoked by someone else first",
    });
  }

  emitSecurityEvent({
    eventType: "mandate.granted",
    actorUserId: actingUserId ?? null,
    orgId: ctx.orgId,
    workspaceId,
    capability: "grant_mandate",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  logger.info(
    {
      mandateId: row.publicId,
      agentId: input.agentId,
      roleAtGrant,
      workspaceId,
    },
    "grant_mandate: granted",
  );

  const [out] = await withTenantDb((tx) => mapMandates(tx, workspaceId, [row]));
  return out!;
};
