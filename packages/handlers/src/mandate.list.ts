// list_mandates — the ledger view the accountable office reads (Tools ›
// mandates) and the mandates one agent holds (Agents › mandates). Each row
// carries remaining authority by measure from the ledger (INV-10).
//
// audit-exempt: read-only; the kernel's capability.invoke_* row is the audit.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { mapMandates, readerFilter, requireWorkspace } from "./_mandate";

export const mandateListHandler: CapabilityHandler<typeof mandateList> = async (
  input,
  ctx,
) => {
  const workspaceId = requireWorkspace(ctx, "list_mandates");
  const operatorId = await readerFilter(ctx);

  return withTenantDb(async (tx) => {
    // A requested agent narrows by its principal id; resolved regardless of
    // reader scope, since visibility of the *mandate* rows below (not this
    // lookup) is what enforces who may see them.
    let agentPrincipalId: string | undefined;
    if (input.agentId !== undefined) {
      const [agent] = await tx
        .select({ principalId: schema.agents.principalId })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.workspaceId, workspaceId),
            eq(schema.agents.publicId, input.agentId),
            isNull(schema.agents.deletedAt),
          ),
        )
        .limit(1);
      if (!agent?.principalId) return { items: [] };
      agentPrincipalId = agent.principalId;
    }

    // Joined for `createdById`: a non-accountable reader sees a mandate for
    // an agent they created, or a mandate they requested themselves for any
    // agent (ADR-107). `request_mandate` admits a workspace Owner or Member
    // to request a mandate for any agent, not only one they created, so
    // narrowing only by the agent's creator would let a requester create a
    // draft they can never read back.
    const rows = await tx
      .select({ mandate: schema.mandates })
      .from(schema.mandates)
      .leftJoin(
        schema.agents,
        eq(schema.agents.principalId, schema.mandates.agentPrincipalId),
      )
      .where(
        and(
          eq(schema.mandates.workspaceId, workspaceId),
          input.status !== undefined
            ? eq(schema.mandates.status, input.status)
            : undefined,
          agentPrincipalId !== undefined
            ? eq(schema.mandates.agentPrincipalId, agentPrincipalId)
            : undefined,
          operatorId !== null
            ? or(
                eq(schema.agents.createdById, operatorId),
                eq(schema.mandates.requestedBy, operatorId),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.mandates.createdAt))
      .limit(input.limit);
    return {
      items: await mapMandates(
        tx,
        workspaceId,
        rows.map((r) => r.mandate),
      ),
    };
  });
};
