// capability-holder.ts: does this user hold a capability in this workspace,
// as the organization's IAM data grants it?
//
// A handler asks this when a second capability widens what the invoked one
// may do. merge_steering_pr asks it for merge_pr_without_review: the merge
// needs no approval when the merger holds that capability (ADR-213).
//
// It asks the resolver directly (`fetchAuthz`, then the pure `resolve`) and
// never the kernel's `checkIAM`. The kernel gate answers `tier_gate → allow`
// on every tier but enterprise, so asking it would make every member a
// holder on most plans. capability-policy-recheck.ts takes the same route
// for the same reason.
//
// It differs from that guard in one input. The guard passes
// `defaultEffect: "allow"` because it asks whether anything revoked a
// capability the caller already holds. This asks whether the caller holds
// the capability at all, so it passes the contract's own `defaultEffect`.
// A caller no role grant names falls to that default, which is `deny` for
// merge_pr_without_review. The system org Owner is allowed by the resolver's
// rule 7.5, and an explicit deny on one of the caller's roles wins over an
// allow on another.
//
// Only `allow` holds. A role grant of `require_approval` reads as not held,
// because no approval step runs inside a handler.
//
// It writes no audit row of its own. The kernel's capability.invoke_* row
// records the call the answer was asked for, and the caller records what the
// answer let it do. For a merge that is the trailer and the ledger line.
import {
  ORG_ONLY_WORKSPACE_ID,
  type CapabilityDeclaration,
} from "@oxagen/oxagen";
import { resolve } from "@oxagen/oxagen/iam";
import { fetchAuthz } from "@oxagen/iam";
import { runInTenantScope } from "@oxagen/tenancy";

/** The fields of a contract this reads. */
type HeldCapability = Pick<CapabilityDeclaration, "name" | "defaultEffect">;

/**
 * The principal the resolver evaluates when the caller has no IAM principal
 * row. It matches the kernel's substitution in `check-iam.ts`, so no role
 * holds it and the answer is the contract's default.
 */
const NO_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Whether `userId` holds `capability` in the workspace. True only when the
 * resolver answers `allow`.
 */
export async function holdsCapability(
  capability: HeldCapability,
  scope: { orgId: string; workspaceId: string },
  userId: string,
): Promise<boolean> {
  const { orgId, workspaceId } = scope;
  // `fetchAuthz` reads through `withOrgDb`, which needs a tenant scope.
  const authz = await runInTenantScope({ orgId, workspaceId }, () =>
    fetchAuthz({
      userId,
      apiKeyId: null,
      orgId,
      workspaceId,
      capability: capability.name,
    }),
  );
  const result = resolve({
    principal: authz.principal ?? {
      id: NO_PRINCIPAL_ID,
      kind: "service",
      orgId,
      workspaceId,
    },
    capability: capability.name,
    scope:
      workspaceId === ORG_ONLY_WORKSPACE_ID
        ? { kind: "org", orgId }
        : { kind: "workspace", orgId, workspaceId },
    grants: authz.grants,
    roles: authz.roles,
    roleGrants: authz.roleGrants,
    policies: authz.policies,
    defaultEffect: capability.defaultEffect,
    now: new Date(),
    clientIp: null,
  });
  return result.outcome === "allow";
}
