// request_mandate — an agent operator asks for authority (Agents › mandates,
// ADR-059). Writes a `draft` row that grants nothing: the gate reads active
// mandates only. The accountable role activates it with grant_mandate
// (requestId) or ends it with revoke_mandate.
//
// audit-exempt: a draft is a request, not an authority change; the grant
// (mandate.granted) and the decline (mandate.revoked) are the audited events,
// and the kernel's capability.invoke_* row covers the request itself.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { mandateRequest } from "@oxagen/oxagen/contracts/mandate.request";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  ACCOUNTABLE_ORG_ROLES,
  assertToolsDeclareMeasures,
  mapMandates,
  requireWorkspace,
  resolveAgent,
} from "./_mandate";
import { logger } from "./logger";

export const mandateRequestHandler: CapabilityHandler<
  typeof mandateRequest
> = async (input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "request_mandate");
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ACCOUNTABLE_ORG_ROLES, workspace: ["Owner", "Member"] },
  );

  const [row] = await withTenantDb(async (tx) => {
    const agent = await resolveAgent(tx, workspaceId, input.agentId);
    await assertToolsDeclareMeasures(tx, workspaceId, input);
    return tx
      .insert(schema.mandates)
      .values({
        orgId: ctx.orgId,
        workspaceId,
        agentPrincipalId: agent.principalId,
        requestedBy: actingUserId,
        consequenceTags: input.consequenceTags,
        limits: input.limits,
        targets: input.targets,
        tools: input.tools,
        approvalRules: input.approval,
        purpose: input.purpose,
        validFrom: new Date(input.validFrom),
        validTo: new Date(input.validTo),
        status: "draft",
        createdById: actingUserId ?? undefined,
        updatedById: actingUserId ?? undefined,
      })
      .returning();
  });
  if (!row) throw new Error("[request_mandate] insert returned no row");

  logger.info(
    { mandateId: row.publicId, agentId: input.agentId, workspaceId },
    "request_mandate: draft recorded",
  );
  const [out] = await withTenantDb((tx) => mapMandates(tx, workspaceId, [row]));
  return out!;
};
