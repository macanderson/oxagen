// agent-run-context.ts — Agent RBAC Phase 1 identity plumbing
// (docs/specs/agent-rbac/spec.md §3.1): "Runs carry the principal in
// AuthzContext alongside the human principal."
//
// This module resolves the two-principal AuthzContext a durable agent run
// carries: the AGENT principal (the deployed agent's own delegated
// iam.principals row) and the invoking HUMAN principal it acts on behalf of.
// Deliberately NOT stored per-run — run records already carry lineage
// (runId, parentRunId); this is resolved from the two durable identity rows
// (agent.agents.principalId and iam.principals) each time a run needs it.
//
// Role assignment / grant resolution against these principals is explicitly
// OUT OF SCOPE here — that is p1-role-contracts' job (Phase 2, kernel
// enforcement). This module only assembles WHO is acting.

import { withTenantDb } from "@oxagen/database";
import { schema } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { type ResolvedPrincipal } from "@oxagen/oxagen";

/**
 * The run-time authorization context for an agent run: the agent's OWN
 * delegated principal, plus the human principal it acts on behalf of
 * (the delegation ceiling — an agent's effective permissions are computed
 * against the intersection of the two, per spec §0/§3.1 — intersection
 * resolution itself is p1-role-contracts' concern, not this module's).
 *
 * `principalKind` is a discriminator so callers can tell an agent run's
 * AuthzContext apart from a plain human CheckedContext at a glance, mirroring
 * the `principalKind` attribution already carried by
 * `@oxagen/tenancy`'s `PrincipalAttribution`.
 */
export interface AgentRunAuthzContext {
  readonly principalKind: "agent";
  /** The deployed agent's own delegated IAM principal. */
  readonly agentPrincipal: ResolvedPrincipal;
  /**
   * The human principal that created/invoked this agent — null when the
   * agent's creator has no resolvable principal (e.g. IAM not bootstrapped
   * for this org) or the agent carries no delegation record.
   */
  readonly humanPrincipal: ResolvedPrincipal | null;
}

export interface ResolveAgentRunAuthzContextArgs {
  orgId: string;
  workspaceId: string;
  /** Agent public id (agt_…) or UUID. */
  agentId: string;
  /**
   * The user id of the human who actually ENQUEUED/INVOKED this run, when the
   * enqueue surface captured one (Agent RBAC Phase 2b — threaded via RunSpec
   * `delegation.userId`). When present (non-null), the human side of the
   * delegation ceiling is resolved from THIS user, not from the agent
   * principal's `parentUserId` (the agent's creator): the ceiling is the
   * human the run acts on behalf of. There is deliberately NO fallback to the
   * creator when the invoking user has no principal — humanPrincipal resolves
   * to null and the resolver's unprivileged sentinel applies (fail-closed; a
   * missing delegator never widens access). Absent/null preserves the Phase 1
   * behavior: the creator recorded at provisioning time is the delegator.
   */
  invokingUserId?: string | null;
}

/**
 * Resolve the AuthzContext for one agent run: load the agent's own principal
 * off `agent.agents.principalId`, then resolve the human principal it
 * delegates from via that agent principal's `parentUserId`. Returns null when
 * the agent itself cannot be resolved (unknown/soft-deleted) or carries no
 * principal (pre-Phase-1 data, which cannot exist post-launch since there is
 * no backfill — but the resolver still fails closed rather than throwing).
 */
export async function resolveAgentRunAuthzContext(
  args: ResolveAgentRunAuthzContextArgs,
): Promise<AgentRunAuthzContext | null> {
  const { orgId, workspaceId, agentId, invokingUserId } = args;
  return withTenantDb(async (tx) => {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        agentId,
      );
    const matchColumn = isUuid
      ? eq(schema.agents.id, agentId)
      : eq(schema.agents.publicId, agentId);

    const [agentRow] = await tx
      .select({ principalId: schema.agents.principalId })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, orgId),
          eq(schema.agents.workspaceId, workspaceId),
          matchColumn,
          isNull(schema.agents.deletedAt),
        ),
      )
      .limit(1);

    if (!agentRow?.principalId) return null;

    const [agentPrincipalRow] = await tx
      .select({
        id: schema.principals.id,
        kind: schema.principals.kind,
        orgId: schema.principals.orgId,
        workspaceId: schema.principals.workspaceId,
        parentUserId: schema.principals.parentUserId,
        status: schema.principals.status,
      })
      .from(schema.principals)
      .where(eq(schema.principals.id, agentRow.principalId))
      .limit(1);

    // The agent's own principal must be live — a soft-deleted agent
    // principal (status='deleted', set together with agent deletion) can
    // never anchor a fresh run's AuthzContext.
    if (!agentPrincipalRow || agentPrincipalRow.status === "deleted") {
      return null;
    }

    const agentPrincipal: ResolvedPrincipal = {
      id: agentPrincipalRow.id,
      kind: "agent",
      orgId: agentPrincipalRow.orgId,
      workspaceId: agentPrincipalRow.workspaceId,
    };

    // Delegating human: the run's INVOKING user when the enqueue surface
    // captured one (invokingUserId — see the args doc), otherwise the agent's
    // creator recorded on the agent principal at provisioning time.
    const delegatorUserId = invokingUserId ?? agentPrincipalRow.parentUserId;

    let humanPrincipal: ResolvedPrincipal | null = null;
    if (delegatorUserId) {
      const [humanRow] = await tx
        .select({
          id: schema.principals.id,
          kind: schema.principals.kind,
          orgId: schema.principals.orgId,
          workspaceId: schema.principals.workspaceId,
        })
        .from(schema.principals)
        .where(
          and(
            eq(schema.principals.orgId, orgId),
            eq(schema.principals.parentUserId, delegatorUserId),
            eq(schema.principals.kind, "human"),
          ),
        )
        .limit(1);
      if (humanRow) {
        humanPrincipal = {
          id: humanRow.id,
          kind: "human",
          orgId: humanRow.orgId,
          workspaceId: humanRow.workspaceId,
        };
      }
    }

    return { principalKind: "agent", agentPrincipal, humanPrincipal };
  });
}
