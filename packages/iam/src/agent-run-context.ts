// agent-run-context.ts — resolve the two principals a governed agent run acts
// as (Agent RBAC docs/specs/agent-rbac/spec.md §3.1; run-evidence
// 02-run-attempt-foundation-plan.md Task 5).
//
// A run's ceiling is an INTERSECTION of two authorities, not a choice between
// them: the deployed agent's own delegated principal, and the human principal
// that authorized this execution. This module assembles WHO is acting; the
// pinned ceiling is built from them in authorization-snapshot.ts and enforced
// in live-agent-run-authorization.ts.
//
// ── The initiating human is NOT `principals.parent_user_id` ─────────────────
//
// `parent_user_id` on an agent principal is the agent's CREATOR. Binding the
// creator to a run would mean anyone who can trigger an agent borrows the
// creator's ceiling — a privilege-escalation path that widens silently as the
// creator gains roles, and one the audit trail would misattribute. The run's
// human side is therefore resolved from the AUTHENTICATED initiating user id
// the trusted admission path supplies.
//
// When no initiating user is supplied the human side resolves to null, which
// the ceiling treats as the unprivileged sentinel (no roles, no grants). That
// is strictly narrower than borrowing the creator, so the fallback fails closed.

import { withTenantDb, schema } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { type ResolvedPrincipal } from "@oxagen/oxagen";
import { logger } from "./logger";

/**
 * The run-time authorization context for an agent run: the agent's OWN
 * delegated principal, plus the authenticated human principal it acts on
 * behalf of (the delegation ceiling — an agent's effective permissions are the
 * intersection of the two, per spec §0/§3.1).
 *
 * `principalKind` is a discriminator so callers can tell an agent run's
 * AuthzContext apart from a plain human CheckedContext at a glance, mirroring
 * the `principalKind` attribution already carried by `@oxagen/tenancy`'s
 * `PrincipalAttribution`.
 */
export interface AgentRunAuthzContext {
  readonly principalKind: "agent";
  /** The deployed agent's own delegated IAM principal. */
  readonly agentPrincipal: ResolvedPrincipal;
  /**
   * The AUTHENTICATED initiating human principal — null when the caller
   * supplied no initiating user, or that user has no principal in this org
   * (e.g. IAM not bootstrapped). Null narrows; it never widens.
   */
  readonly humanPrincipal: ResolvedPrincipal | null;
}

export interface ResolveAgentRunAuthzContextArgs {
  orgId: string;
  workspaceId: string;
  /** Agent public id (agt_…) or UUID. */
  agentId: string;
  /**
   * The AUTHENTICATED initiating human's `auth.users` id — whoever actually
   * authorized this execution. Deliberately required (nullable, not optional)
   * so a caller has to state explicitly that there is no initiating human
   * rather than forget the field and silently get a wrong ceiling.
   */
  initiatingUserId: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the AuthzContext for one agent run: the agent's own principal off
 * `agent.agents.principal_id`, and the initiating human's principal resolved
 * from the authenticated user id.
 *
 * Returns null when the agent itself cannot be resolved (unknown, soft-deleted,
 * or carrying no principal) or its principal is not live — a fail-closed null
 * rather than a throw, so the caller decides how to report it.
 */
export async function resolveAgentRunAuthzContext(
  args: ResolveAgentRunAuthzContextArgs,
): Promise<AgentRunAuthzContext | null> {
  const { orgId, workspaceId, agentId, initiatingUserId } = args;
  return withTenantDb(async (tx) => {
    const matchColumn = UUID_RE.test(agentId)
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
        status: schema.principals.status,
      })
      .from(schema.principals)
      .where(eq(schema.principals.id, agentRow.principalId))
      .limit(1);

    // The agent's own principal must be live. A suspended or soft-deleted
    // agent principal can never anchor a fresh run's AuthzContext — and unlike
    // the old check, a SUSPENSION counts: suspending an agent that then keeps
    // starting runs would make the control decorative.
    if (
      !agentPrincipalRow ||
      agentPrincipalRow.status === "deleted" ||
      agentPrincipalRow.status === "suspended"
    ) {
      return null;
    }

    const agentPrincipal: ResolvedPrincipal = {
      id: agentPrincipalRow.id,
      kind: "agent",
      orgId: agentPrincipalRow.orgId,
      workspaceId: agentPrincipalRow.workspaceId,
    };

    let humanPrincipal: ResolvedPrincipal | null = null;
    if (initiatingUserId !== null) {
      const [humanRow] = await tx
        .select({
          id: schema.principals.id,
          orgId: schema.principals.orgId,
          workspaceId: schema.principals.workspaceId,
          status: schema.principals.status,
        })
        .from(schema.principals)
        .where(
          and(
            eq(schema.principals.orgId, orgId),
            eq(schema.principals.parentUserId, initiatingUserId),
            eq(schema.principals.kind, "human"),
          ),
        )
        .limit(1);
      if (humanRow !== undefined && humanRow.status === "active") {
        humanPrincipal = {
          id: humanRow.id,
          kind: "human",
          orgId: humanRow.orgId,
          workspaceId: humanRow.workspaceId,
        };
      } else {
        logger.warn(
          { orgId, agentId, initiatingUserId },
          "[iam] initiating user has no active principal in this org — the " +
            "run's human ceiling resolves to the unprivileged sentinel",
        );
      }
    }

    return { principalKind: "agent", agentPrincipal, humanPrincipal };
  });
}
