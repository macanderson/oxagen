/**
 * Namespace validation and utilities.
 *
 * Namespaces provide hierarchical tenant scoping for all memory records.
 * Every record belongs to exactly one namespace, and queries never cross
 * namespace boundaries without explicit opt-in.
 */
import { NamespaceSchema, type Namespace } from "./types";

/**
 * Error thrown when a namespace fails validation.
 */
export class NamespaceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamespaceScopeError";
  }
}

/**
 * Validate a namespace object. Throws NamespaceScopeError if invalid.
 */
export function validateNamespace(ns: unknown): Namespace {
  const result = NamespaceSchema.safeParse(ns);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new NamespaceScopeError(`Invalid namespace: ${issues}`);
  }
  return result.data;
}

/**
 * Convert a namespace to a canonical string key for indexing/partitioning.
 * Format: `org:workspace[:session[:agent]]`
 *
 * The nesting is strict: `agent` is only appended when `session` is also set.
 * A namespace with an agent but no session therefore keys as plain
 * `org:workspace`, and two such namespaces with DIFFERENT agents collide on
 * one key. Do not use this key as a partition or cache identity for
 * agent-scoped, session-less namespaces — the record's own `namespace` object
 * is the authority; this is only a display/index convenience.
 */
export function namespaceKey(ns: Namespace): string {
  let key = `${ns.org}:${ns.workspace}`;
  if (ns.session) {
    key += `:${ns.session}`;
    if (ns.agent) {
      key += `:${ns.agent}`;
    }
  }
  return key;
}

/**
 * Check whether `child` is scoped within `parent`.
 * A namespace is "within" another if it shares the same org and workspace,
 * and optionally narrows session/agent.
 */
export function isWithinNamespace(
  child: Namespace,
  parent: Namespace,
): boolean {
  if (child.org !== parent.org) return false;
  if (child.workspace !== parent.workspace) return false;
  // If parent specifies a session, child must match it.
  if (parent.session && child.session !== parent.session) return false;
  // If parent specifies an agent, child must match it.
  if (parent.agent && child.agent !== parent.agent) return false;
  return true;
}

/**
 * Create a workspace-scoped namespace (most common case).
 */
export function workspaceNamespace(org: string, workspace: string): Namespace {
  return { org, workspace };
}

/**
 * Create a session-scoped namespace (narrows to a single session).
 */
export function sessionNamespace(
  org: string,
  workspace: string,
  session: string,
  agent?: string,
): Namespace {
  return { org, workspace, session, agent };
}
