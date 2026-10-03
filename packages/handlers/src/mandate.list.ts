// list_mandates — the ledger view the accountable office reads (Tools ›
// mandates) and the mandates one agent holds (Agents › mandates). Each row
// carries remaining authority by measure from the ledger (INV-10).
//
// audit-exempt: read-only; the kernel's capability.invoke_* row is the audit.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { mapMandates, readerFilter, requireWorkspace } from "./_mandate";

export const mandateListHandler: CapabilityHandler<typeof mandateList> = async (
  input,
  ctx,
) => {
  const workspaceId = requireWorkspace(ctx, "list_mandates");
  const operatorId = await readerFilter(ctx);
  // The one instant this answer describes (#3152), read before any row is.
  // Every row's authority is counted at it and the answer returns it, so two
  // rows read on either side of a UTC period boundary cannot sit in two
  // periods, and the app judges each window against this instant, not its own.
  const at = new Date();
  const asOf = at.toISOString();
  const a = schema.agents;
  const m = schema.mandates;

  return withTenantDb(async (tx) => {
    // A non-accountable reader sees a mandate for an agent they created, or
    // a mandate they requested themselves for any agent (ADR-107), and either
    // only while the agent is live (not soft-deleted). `request_mandate`
    // admits a workspace Owner or Member to request a mandate for any agent,
    // not only one they created, so narrowing only by the agent's creator
    // would let a requester create a draft they can never read back.
    //
    // The narrowing is a condition Postgres evaluates against the mandate rows
    // (#3450). It used to select every live agent in the workspace and send
    // the whole list back as bind parameters, so the read's cost grew with
    // the fleet whatever the page asked for, and a large enough fleet passed
    // the bind-parameter limit. `agents` (agent schema) and `mandates` (tools
    // schema) are cross-domain with no foreign key, so the condition is a
    // Drizzle subquery over `agents` and not a raw JOIN.
    let agentPrincipalId: string | undefined;
    let readerScope: SQL | undefined;
    if (input.agentId !== undefined) {
      // A requested agent narrows by its principal id. It is resolved
      // whatever the reader's scope, since visibility of the mandate rows
      // below, not this lookup, is what enforces who may see them.
      const [agent] = await tx
        .select({ principalId: a.principalId, createdById: a.createdById })
        .from(a)
        .where(
          and(
            eq(a.workspaceId, workspaceId),
            eq(a.publicId, input.agentId),
            isNull(a.deletedAt),
          ),
        )
        .limit(1);
      if (!agent?.principalId) return { items: [], asOf };
      agentPrincipalId = agent.principalId;
      // The lookup admits only a live agent, so this one row is all a
      // narrowed reader's scope needs: every mandate of an agent they
      // created, or only the ones they requested of anyone else's.
      if (operatorId !== null && agent.createdById !== operatorId) {
        readerScope = eq(m.requestedBy, operatorId);
      }
    } else if (operatorId !== null) {
      const liveAgents = (createdById?: string) =>
        tx
          .select({ principalId: a.principalId })
          .from(a)
          .where(
            and(
              eq(a.workspaceId, workspaceId),
              isNull(a.deletedAt),
              createdById === undefined
                ? undefined
                : eq(a.createdById, createdById),
            ),
          );
      // A reader who created no live agent and requested nothing reads
      // nothing: each branch is an `in` over a subquery that answers no row.
      readerScope = or(
        inArray(m.agentPrincipalId, liveAgents(operatorId)),
        and(
          eq(m.requestedBy, operatorId),
          inArray(m.agentPrincipalId, liveAgents()),
        ),
      );
    }

    const rows = await tx
      .select()
      .from(m)
      .where(
        and(
          eq(m.workspaceId, workspaceId),
          input.status !== undefined ? eq(m.status, input.status) : undefined,
          agentPrincipalId !== undefined
            ? eq(m.agentPrincipalId, agentPrincipalId)
            : undefined,
          readerScope,
        ),
      )
      .orderBy(desc(m.createdAt))
      .limit(input.limit);
    return { items: await mapMandates(tx, workspaceId, rows, at), asOf };
  });
};
