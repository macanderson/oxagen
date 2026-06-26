/**
 * Namespace enforcement and access control for the multi-agent blackboard.
 *
 * Every read/write is verified against the agent's permissions. The hierarchy:
 * - Agent private: only the owning agent can read/write
 * - Session shared: all agents in the session can read/write
 * - Workspace shared: all agents can read, only consolidation can write
 * - Cross-org: NEVER allowed
 */
import type { Namespace } from "../types";
import { isWithinNamespace } from "../namespace";

export interface NamespaceGrant {
  namespace: Namespace;
  scope: "own" | "session" | "workspace";
}

export interface AgentPermissions {
  agentId: string;
  read: NamespaceGrant[];
  write: NamespaceGrant[];
}

export class NamespaceAccessError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly operation: "read" | "write",
    public readonly targetNamespace: Namespace,
  ) {
    super(
      `Agent ${agentId} denied ${operation} access to namespace ${targetNamespace.org}/${targetNamespace.workspace}/${targetNamespace.session ?? "*"}/${targetNamespace.agent ?? "*"}`,
    );
    this.name = "NamespaceAccessError";
  }
}

/**
 * Default permissions for an agent:
 * - Read/write its own private namespace
 * - Read/write the session's shared blackboard
 * - Read (only) the workspace-level persistent memory
 */
export function defaultAgentPermissions(
  agentId: string,
  org: string,
  workspace: string,
  session: string,
): AgentPermissions {
  return {
    agentId,
    read: [
      { namespace: { org, workspace, session, agent: agentId }, scope: "own" },
      { namespace: { org, workspace, session }, scope: "session" },
      { namespace: { org, workspace }, scope: "workspace" },
    ],
    write: [
      { namespace: { org, workspace, session, agent: agentId }, scope: "own" },
      { namespace: { org, workspace, session }, scope: "session" },
    ],
  };
}

/**
 * Check if a namespace grant covers the target namespace.
 * A grant covers a target if:
 * - The target is within the grant's namespace boundaries
 * - For agent-scoped targets: only "own" scope grants cover them,
 *   OR the target's agent matches the grant's agent
 */
function grantCovers(grant: NamespaceGrant, target: Namespace): boolean {
  // Agent-private namespaces require an exact agent match in the grant
  if (
    target.agent &&
    grant.namespace.agent &&
    target.agent !== grant.namespace.agent
  ) {
    return false;
  }
  // If target is agent-scoped but grant is only session/workspace level,
  // deny access (session grants cover shared session, not private agents)
  if (target.agent && !grant.namespace.agent) {
    return false;
  }
  return isWithinNamespace(target, grant.namespace);
}

/**
 * Enforce access control on an Engram operation.
 * Throws NamespaceAccessError if denied.
 */
export function enforceAccess(
  agentId: string,
  operation: "read" | "write",
  targetNamespace: Namespace,
  permissions: AgentPermissions,
): void {
  const grants = operation === "read" ? permissions.read : permissions.write;
  const allowed = grants.some((g) => grantCovers(g, targetNamespace));
  if (!allowed) {
    throw new NamespaceAccessError(agentId, operation, targetNamespace);
  }
}

/**
 * Check access without throwing (returns boolean).
 */
export function hasAccess(
  operation: "read" | "write",
  targetNamespace: Namespace,
  permissions: AgentPermissions,
): boolean {
  const grants = operation === "read" ? permissions.read : permissions.write;
  return grants.some((g) => grantCovers(g, targetNamespace));
}
