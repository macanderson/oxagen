// list_mandates — the ledger view the accountable office reads (Tools ›
// mandates) and the mandates one agent holds (Agents › mandates). Each row
// carries remaining authority by measure from the ledger (INV-10).
//
// audit-exempt: read-only; the kernel's capability.invoke_* row is the audit.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { mapMandates, readerFilter, requireWorkspace } from "./_mandate";

export const mandateListHandler: CapabilityHandler<typeof mandateList> = async (
  input,
  ctx,
) => {
  const workspaceId = requireWorkspace(ctx, "list_mandates");
  const operatorId = await readerFilter(ctx);

  return withTenantDb(async (tx) => {
    // The agents whose mandates the caller may see: one agent when asked
    // for, the operator's own agents for a non-accountable reader.
    let principalIds: string[] | null = null;
    if (input.agentId !== undefined || operatorId !== null) {
      const agents = await tx
        .select({ principalId: schema.agents.principalId })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.workspaceId, workspaceId),
            isNull(schema.agents.deletedAt),
            input.agentId !== undefined
              ? eq(schema.agents.publicId, input.agentId)
              : undefined,
            operatorId !== null
              ? eq(schema.agents.createdByUserId, operatorId)
              : undefined,
          ),
        );
      principalIds = agents
        .map((a) => a.principalId)
        .filter((id): id is string => id !== null);
      if (principalIds.length === 0) return { items: [] };
    }

    const rows = await tx
      .select()
      .from(schema.mandates)
      .where(
        and(
          eq(schema.mandates.workspaceId, workspaceId),
          input.status !== undefined
            ? eq(schema.mandates.status, input.status)
            : undefined,
          principalIds !== null
            ? inArray(schema.mandates.agentPrincipalId, principalIds)
            : undefined,
        ),
      )
      .orderBy(desc(schema.mandates.createdAt))
      .limit(input.limit);
    return { items: await mapMandates(tx, workspaceId, rows) };
  });
};
