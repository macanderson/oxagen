// list_mandates — the ledger view the accountable office reads (Tools ›
// mandates) and the mandates one agent holds (Agents › mandates). Each row
// carries remaining authority by measure from the ledger (INV-10).
//
// audit-exempt: read-only; the kernel's capability.invoke_* row is the audit.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
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

    // `agents` (agent schema) and `mandates` (tools schema) are cross-domain;
    // no cross-schema FK, and this repo's storage rules keep a cross-domain
    // Postgres relationship out of a raw JOIN inside a handler, so the
    // creator set is its own query, same as the agentId lookup above, rather
    // than a `leftJoin` against `mandates`.
    //
    // A non-accountable reader sees a mandate for an agent they created, or
    // a mandate they requested themselves for any agent (ADR-107).
    // `request_mandate` admits a workspace Owner or Member to request a
    // mandate for any agent, not only one they created, so narrowing only
    // by the agent's creator would let a requester create a draft they can
    // never read back.
    let readerScope: SQL | undefined;
    if (operatorId !== null) {
      const liveAgents = await tx
        .select({
          principalId: schema.agents.principalId,
          createdById: schema.agents.createdById,
        })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.workspaceId, workspaceId),
            isNull(schema.agents.deletedAt),
          ),
        );
      const createdByOperator = liveAgents
        .filter((a) => a.createdById === operatorId)
        .map((a) => a.principalId)
        .filter((id): id is string => id !== null);
      // A requester's visibility is narrowed to a *live* agent too: a
      // soft-deleted agent's mandate is not readable through the requester
      // grant just because `deletedAt` on the agent row happens to be the
      // only thing standing between the requester and someone else's now-gone
      // agent's ledger (ADR-107, follow-on finding).
      const livePrincipalIds = liveAgents
        .map((a) => a.principalId)
        .filter((id): id is string => id !== null);
      readerScope =
        or(
          createdByOperator.length > 0
            ? inArray(schema.mandates.agentPrincipalId, createdByOperator)
            : undefined,
          livePrincipalIds.length > 0
            ? and(
                eq(schema.mandates.requestedBy, operatorId),
                inArray(schema.mandates.agentPrincipalId, livePrincipalIds),
              )
            : undefined,
        ) ??
        // Drizzle's `or()` returns `undefined` when every operand is
        // `undefined`, and `and()` treats an `undefined` member as absent
        // rather than as "refuse everything", so a narrowed reader in a
        // workspace with no live agents at all (every agent soft-deleted)
        // would otherwise fall through to the unfiltered `and(...)` below
        // and see every mandate in the workspace, accountable roles
        // included. A narrowed reader with nothing to narrow by reads
        // nothing, never everything.
        sql`false`;
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
          agentPrincipalId !== undefined
            ? eq(schema.mandates.agentPrincipalId, agentPrincipalId)
            : undefined,
          readerScope,
        ),
      )
      .orderBy(desc(schema.mandates.createdAt))
      .limit(input.limit);
    return { items: await mapMandates(tx, workspaceId, rows) };
  });
};
