// capability-policy-recheck.ts: has anything explicitly revoked this
// capability, for a handler acting on authority captured earlier?
//
// Why a role re-read is not enough. A handler that hands over something
// assembled minutes ago has two revocation paths to observe, not one. The
// first is the role: an Owner can be demoted or removed, and
// `_org_membership.ts` answers that. The second is the capability policy: an
// administrator can leave every role alone and write an explicit `deny`
// against the capability itself (`iam.role_grants.effect`, whose CHECK is
// `IN ('allow','deny','require_approval')`). `org_users.role` cannot see that
// row, so a role re-read reports a revoked mandate as intact.
//
// Why not `checkIAM`. The kernel's gate returns `tier_gate → allow` before
// `fetchAuthz` runs whenever `canAccessACL(tier)` is false, which is every
// tier but enterprise (packages/iam/src/check-iam.ts, packages/billing
// entitlements). Routing this question through it would answer "allowed" on
// the tiers most customers are on, which is the failure mode a guard like this
// exists to close: an explicit deny that does not deny is worse than no
// control at all, because the administrator who wrote it believes access is
// gone. So this asks the resolver directly (`fetchAuthz`, then the pure
// `resolve`) and never consults the plan tier. That is the shape
// `capability-role-guard.ts` takes for the role half of the same question, and
// for the same reason.
//
// It is defence in depth, not a replacement for the kernel gate, and it runs
// for the capability whose mandate the action rests on, which is not
// necessarily the capability being invoked: a download route invokes
// `get_export_status`, and the authority it spends is `export_data`'s.
//
// ## What it asks, and what it deliberately does not ask
//
// It asks ONE question: has an explicit rule revoked this capability for this
// caller? It does not re-derive authorization. The handler's own role check
// does that, and a second opinion on it would be a second place to drift from.
//
// That is why `resolve` is called with `defaultEffect: "allow"` rather than the
// contract's own. Rule 8 is the resolver's "nothing matched" fallback, so
// passing `allow` makes a non-allow answer mean exactly "something explicit
// said no": rules 1, 2, 6 and 7, which all hard-stop before rule 8. Passing
// the contract's `defaultEffect` instead would turn the ABSENCE of policy into
// a refusal for every contract that denies by default (`erase_data` does), so
// an organisation whose IAM principals were never provisioned would lose a
// GDPR right to a guard meant to catch a revocation. An authorization gap
// would have become an availability failure.
//
// A missing IAM migration is the one absence that still refuses: `fetchAuthz`
// synthesizes an org-enforced deny for it (its `denyAuthz`), which is rule 2
// and therefore explicit. That refusal is the honest one. With the policy
// tables gone there is no way to establish that the mandate still holds.

import {
  ORG_ONLY_WORKSPACE_ID,
  type CapabilityContext,
  type CapabilityDeclaration,
} from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { resolve } from "@oxagen/oxagen/iam";
import { emitAudit, fetchAuthz } from "@oxagen/iam";
import { runInTenantScope } from "@oxagen/tenancy";

/** The one field of a contract this guard reads. */
export type PolicyGatedCapability = Pick<CapabilityDeclaration, "name">;

/**
 * The sentinel principal the resolver evaluates when no IAM principal row
 * exists for the caller. Matches the kernel's own substitution in
 * `check-iam.ts`, so a principal-less caller resolves identically here: no
 * role matches it, and the answer is the `allow` fallback above.
 */
const NO_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Whether an explicit rule currently revokes `capability` for this caller, at
 * every plan tier, and what it decided.
 *
 * `revoked` is true for an explicit `deny` and for an explicit
 * `require_approval`: the approval step is read only by the agent tool wrapper
 * (packages/agent/src/runtime/materialize-tools.ts), so on the API and app
 * surfaces there is nothing to satisfy, and denying is the fail-closed
 * reading, the same one `permittedRoles()` takes.
 */
export async function capabilityRevocation(
  capability: PolicyGatedCapability,
  ctx: CapabilityContext,
): Promise<{ revoked: boolean; decidedBy: string }> {
  // `fetchAuthz` reads through `withOrgDb`, which requires an active tenant
  // scope. This guard runs inside handlers of UNSCOPED capabilities too
  // (`get_export_status` is `scoped: false`), so the scope is entered here
  // rather than assumed. A caller naming no workspace uses the org-only
  // sentinel (ADR-068), which is what an org-wide read expects.
  const workspaceId = ctx.workspaceId ?? ORG_ONLY_WORKSPACE_ID;
  const authz = await runInTenantScope({ orgId: ctx.orgId, workspaceId }, () =>
    fetchAuthz({
      userId: ctx.userId ?? null,
      apiKeyId: ctx.apiKeyId ?? null,
      orgId: ctx.orgId,
      workspaceId,
      capability: capability.name,
    }),
  );

  const result = resolve({
    principal: authz.principal ?? {
      id: NO_PRINCIPAL_ID,
      kind: "service",
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId ?? null,
    },
    capability: capability.name,
    // Org scope when the caller names no real workspace: a workspace-keyed
    // rule cannot bind a call that is in no workspace, and org rules still
    // match either way.
    scope:
      ctx.workspaceId && ctx.workspaceId !== ORG_ONLY_WORKSPACE_ID
        ? { kind: "workspace", orgId: ctx.orgId, workspaceId: ctx.workspaceId }
        : { kind: "org", orgId: ctx.orgId },
    grants: authz.grants,
    roles: authz.roles,
    roleGrants: authz.roleGrants,
    policies: authz.policies,
    // See the module comment: "nothing matched" must read as "nothing revoked
    // it", not as a refusal.
    defaultEffect: "allow",
    now: new Date(),
    clientIp: ctx.clientIp ?? null,
  });

  // The re-evaluation goes on the record, the same stream the kernel's own
  // check writes to, so a refusal is answerable afterwards rather than only
  // observable as a 403. Fire-and-forget, like every other emitAudit caller: a
  // decision that was made is not unmade by a failed log write, and this guard
  // must not fail a read because ClickHouse is unreachable.
  void emitAudit({
    capability: capability.name,
    ctx,
    principal: authz.principal,
    result,
    trace: result.trace,
    rawInputJson: JSON.stringify({ recheck: "capability_revocation" }),
  }).catch(() => undefined);

  return {
    revoked: result.outcome !== "allow",
    decidedBy: result.trace.decidedBy.rule,
  };
}

/**
 * Refuse when an explicit rule has revoked `capability` for this caller.
 *
 * Throws the same typed shape as the role re-check beside it, a `forbidden`
 * `HandlerError` with a stable `reason`, so both revocation paths read alike
 * on every surface.
 */
export async function assertCapabilityNotRevoked(
  capability: PolicyGatedCapability,
  ctx: CapabilityContext,
  args: { reason: string; message: string },
): Promise<void> {
  const { revoked } = await capabilityRevocation(capability, ctx);
  if (!revoked) return;
  throw new HandlerError({
    code: "forbidden",
    reason: args.reason,
    message: args.message,
  });
}
