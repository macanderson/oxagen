// get_mandate — one mandate with remaining authority by measure and its
// ledger rows newest first (the mandate page). Same readers as list_mandates.
//
// audit-exempt: read-only; the kernel's capability.invoke_* row is the audit.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { mandateGet } from "@oxagen/oxagen/contracts/mandate.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import {
  loadMandateRow,
  mapMandates,
  readerFilter,
  requireWorkspace,
} from "./_mandate";

export const mandateGetHandler: CapabilityHandler<typeof mandateGet> = async (
  input,
  ctx,
) => {
  const workspaceId = requireWorkspace(ctx, "get_mandate");
  const operatorId = await readerFilter(ctx);

  return withTenantDb(async (tx) => {
    const row = await loadMandateRow(tx, workspaceId, input.mandateId);
    if (operatorId !== null) {
      const [agent] = await tx
        .select({ createdById: schema.agents.createdById })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.workspaceId, workspaceId),
            eq(schema.agents.principalId, row.agentPrincipalId),
          ),
        )
        .limit(1);
      // A non-accountable reader reads a mandate for an agent they created,
      // or a mandate they requested themselves for any agent (ADR-107): the
      // two are independent grants of visibility, not one narrowed by the
      // other. `request_mandate` admits a workspace Owner or Member to
      // request a mandate for any agent, not only one they created, so
      // narrowing only by the agent's creator would let a requester create
      // a draft they can never read back.
      if (agent?.createdById !== operatorId && row.requestedBy !== operatorId) {
        throw new HandlerError({
          code: "forbidden",
          reason: "org_role_required",
          message:
            "Mandates are readable by the accountable office, the agent's operator, and whoever requested them",
        });
      }
    }
    const [mandate] = await mapMandates(tx, workspaceId, [row]);
    const l = schema.mandateLedger;
    const ledger = await tx
      .select()
      .from(l)
      .where(eq(l.mandateId, row.id))
      .orderBy(desc(l.createdAt), desc(l.id))
      .limit(input.ledgerLimit);
    return {
      mandate: mandate!,
      ledger: ledger.map((r) => ({
        id: r.id,
        toolCallId: r.toolCallId,
        kind: r.kind as "reserve" | "settle" | "release",
        measure: r.measure,
        value: r.value,
        unitOrCurrency: r.unitOrCurrency,
        externalEffectId: r.externalEffectId,
        periodKey: r.periodKey,
        balanceAfter: r.balanceAfter,
        at: r.createdAt.toISOString(),
      })),
    };
  });
};
