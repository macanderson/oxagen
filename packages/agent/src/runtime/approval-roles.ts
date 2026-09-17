/**
 * The IAM roles `resolve_approval` admits, read from its contract's
 * `defaultRoles`. The handler's `assertOrgRole` gate and the recipients of
 * `approval.requested` (`createApprovalRequest`) take these lists, so who may
 * resolve an approval and who is told about one cannot drift apart.
 */
import { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";

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
