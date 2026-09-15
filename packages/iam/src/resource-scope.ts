// resource-scope.ts — the one digest a `resource_scope` emergency deny is
// matched by.
//
// `iam.emergency_denies.resource_scope_digest` names the object a deny stops:
// `sha256:` over the JCS canonical form of `{ id, kind }`. The writer
// (set_kill_switch, packages/handlers/src/kill_switch.set.ts) and every reader
// — the kernel's agent-run check (check-iam.ts, which derives the digest from
// the contract's declared audit target, #1261) and the tool gateway's
// kill-switch gate (packages/agent/src/runtime/kill-switch-gate.ts) — call
// this function and nothing else, so a deny written for `{kind, id}` can never
// miss the call that targets `{kind, id}`.
//
// Which `id` a kind is digested over is fixed here (ADR-065 §4): the value the
// live check has in hand at the call boundary, so no lookup sits on the hot
// path.

import { digestJcs } from "@oxagen/run-evidence";

interface ResourceScopeTarget {
  readonly kind: string;
  readonly id: string;
}

/** `sha256:` + hex over JCS(`{ id, kind }`). */
export function resourceScopeDigestOf(target: ResourceScopeTarget): string {
  return digestJcs({ id: target.id, kind: target.kind });
}

/**
 * The scopes every governed call carries whether or not its contract names
 * an audit target: the organisation, the workspace, the agent (its public
 * `agt_…` id) and the initiating operator (their user id). A kill switch on
 * any of them is a `resource_scope` deny over the same `{kind, id}`.
 */
interface ImplicitScopeArgs {
  readonly orgId: string;
  readonly workspaceId: string | null;
  /** The agent's public id (`agt_…`), as `AgentRunIAMContext.agentId` carries it. */
  readonly agentId: string | null;
  /** The initiating human's user id. */
  readonly operatorUserId: string | null;
}

export function implicitScopeDigests(args: ImplicitScopeArgs): string[] {
  const digests = [resourceScopeDigestOf({ kind: "org", id: args.orgId })];
  if (args.workspaceId) {
    digests.push(
      resourceScopeDigestOf({ kind: "workspace", id: args.workspaceId }),
    );
  }
  if (args.agentId) {
    digests.push(resourceScopeDigestOf({ kind: "agent", id: args.agentId }));
  }
  if (args.operatorUserId) {
    digests.push(
      resourceScopeDigestOf({ kind: "operator", id: args.operatorUserId }),
    );
  }
  return digests;
}
