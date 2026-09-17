/**
 * approval-notify.ts — who is told that an approval is waiting, and the one
 * place that tells them.
 *
 * MC spec §7.7 `approval.requested`: one feed row per person who may resolve
 * the approval, written INSIDE the transaction that creates the approval row,
 * so neither exists without the other.
 *
 * It lives here, in `@oxagen/rules`, because there are two writers of
 * `agent.approval_requests` and this is the lowest package both can reach:
 * the runtime's `createApprovalRequest` (`@oxagen/agent`, which depends on
 * this package) and the mandate gate's own insert (`mandates.ts`, next door).
 * It started in the runtime, and the mandate gate — which parks a call when a
 * mandate's `alwaysHumanFor` or `humanAbove` rule fires — never ran it. Those
 * approvals appeared in `list_approvals` and notified nobody, so the ones a
 * person had to go looking for were exactly the ones a rule had decided a
 * person must see. A parked call that nobody is told about expires, and an
 * expiry is indistinguishable from a considered refusal in the record.
 *
 * Any future writer of an approval row belongs behind this function too. The
 * shape that caused the bug is a fan-out attached to ONE caller rather than
 * to the row it describes.
 */
import { schema, type Tx } from "@oxagen/database";
import { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { logger } from "./logger";

/**
 * The IAM roles `resolve_approval` admits, read from its contract's
 * `defaultRoles`. Its `assertOrgRole` gate and the recipients of
 * `approval.requested` take the same lists, so who may resolve an approval
 * and who is told about one cannot drift apart.
 */
export const APPROVAL_RESOLVER_ROLES = {
  org: allowedRoles(agentApprovalResolve.defaultRoles.org),
  workspace: allowedRoles(agentApprovalResolve.defaultRoles.workspace),
};

function allowedRoles(
  grants: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  return Object.entries(grants ?? {})
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

/**
 * The most people one approval notifies. `APPROVAL_RESOLVER_ROLES.workspace`
 * is Owner and Member — effectively everyone — so an unbounded fan-out writes
 * one row per member of the workspace inside the approval's transaction. A
 * 400-member workspace parks one write and holds a 400-row insert; near 8,000
 * it crosses Postgres's 65,535 bind-parameter ceiling and the approval itself
 * fails, so the person never gets the card the fan-out existed to deliver.
 *
 * Past the cap the approval is still written and still resolvable — the feed
 * is a convenience, the approval row is the record — and the truncation is
 * logged with the count so it is visible rather than silent.
 */
export const APPROVAL_NOTIFY_MAX_RECIPIENTS = 200;

/** Rows per insert statement, so one statement never approaches the ceiling. */
export const APPROVAL_NOTIFY_CHUNK = 50;

export interface ApprovalNotifyArgs {
  orgId: string;
  workspaceId: string;
  /** The capability the parked call would have run. */
  capabilityName: string;
  /** The tool's risk grade, as the approval row records it. */
  riskLevel: string;
  expiresAt: Date;
}

/**
 * Write one `approval.requested` feed row per person who may resolve this
 * approval. Call it inside the same transaction as the approval's own insert.
 */
export async function notifyApprovalRequested(
  tx: Tx,
  args: ApprovalNotifyArgs,
): Promise<void> {
  const { approvers, truncated } = await approverUserIds(
    tx,
    args.orgId,
    args.workspaceId,
  );
  if (truncated) {
    logger.warn(
      {
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        capabilityName: args.capabilityName,
        notified: approvers.length,
      },
      "approval.requested fan-out truncated: more people may resolve this approval than the cap notifies",
    );
  }
  for (let i = 0; i < approvers.length; i += APPROVAL_NOTIFY_CHUNK) {
    await tx.insert(schema.notifications).values(
      approvers.slice(i, i + APPROVAL_NOTIFY_CHUNK).map((userId) => ({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        userId,
        kind: "approval" as const,
        event: "approval.requested" as const,
        title: `Approval requested: ${args.capabilityName}`,
        body: `Risk ${args.riskLevel}. Expires ${args.expiresAt.toISOString()}.`,
        deepLink: null,
      })),
    );
  }
}

/**
 * The people `resolve_approval` admits, resolved the way its gate resolves
 * them (`assertOrgRole` in @oxagen/iam): an active human principal in the
 * org holding an undeleted, unexpired assignment of an admitted role, either
 * org-wide (`workspace_id IS NULL`) or on this workspace.
 */
export async function approverUserIds(
  tx: Tx,
  orgId: string,
  workspaceId: string,
): Promise<{ approvers: string[]; truncated: boolean }> {
  const p = schema.principals;
  const pra = schema.principalRoleAssignments;
  const roles = schema.roles;
  const rows = await tx
    .select({ userId: p.parentUserId })
    .from(p)
    .innerJoin(pra, eq(pra.principalId, p.id))
    .innerJoin(roles, eq(roles.id, pra.roleId))
    .where(
      and(
        eq(p.orgId, orgId),
        eq(p.kind, "human"),
        eq(p.status, "active"),
        eq(pra.orgId, orgId),
        isNull(pra.deletedAt),
        or(isNull(pra.expiresAt), gt(pra.expiresAt, new Date())),
        or(
          and(
            eq(roles.scopeKind, "org"),
            isNull(pra.workspaceId),
            inArray(roles.name, APPROVAL_RESOLVER_ROLES.org),
          ),
          and(
            eq(roles.scopeKind, "workspace"),
            eq(pra.workspaceId, workspaceId),
            inArray(roles.name, APPROVAL_RESOLVER_ROLES.workspace),
          ),
        ),
      ),
    )
    // One person can hold several admitted roles, so rows outnumber people;
    // read one page past the cap on distinct users rather than guessing.
    .limit((APPROVAL_NOTIFY_MAX_RECIPIENTS + 1) * 4);
  const distinct = [
    ...new Set(rows.flatMap((r) => (r.userId === null ? [] : [r.userId]))),
  ];
  return {
    approvers: distinct.slice(0, APPROVAL_NOTIFY_MAX_RECIPIENTS),
    truncated: distinct.length > APPROVAL_NOTIFY_MAX_RECIPIENTS,
  };
}
