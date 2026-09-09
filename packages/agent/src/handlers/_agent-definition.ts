// Shared row-resolution helpers for the agent-definition handlers.
// Every lookup is workspace-scoped: an identifier never resolves a row from a
// different workspace, even if the caller guesses another workspace's id.

import { withTenantDb, schema } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import {
  isManagedAgentType,
  MANAGED_AGENT_READONLY_CODE,
} from "@oxagen/oxagen/interactive-agent";

// ─── Managed-agent guard ─────────────────────────────────────────────────────

/**
 * Error thrown when a mutation targets a product-managed (built-in) agent.
 * The stable `.code` lets callers discriminate without string-matching.
 */
export class AgentManagedReadOnlyError extends Error {
  readonly code = MANAGED_AGENT_READONLY_CODE;
  constructor(identifier: string) {
    super(`Agent "${identifier}" is managed by Oxagen and cannot be modified.`);
    this.name = "AgentManagedReadOnlyError";
  }
}

/**
 * Throw `AgentManagedReadOnlyError` if the agent is product-managed (read-only
 * to customers). Call this immediately after the null-check on every mutating
 * handler so API + MCP + app all honour the constraint via the same code path.
 */
export function assertAgentMutable(
  agent: Pick<AgentRow, "agentType" | "publicId" | "slug">,
): void {
  if (isManagedAgentType(agent.agentType)) {
    throw new AgentManagedReadOnlyError(agent.publicId);
  }
}

// Re-export so callers can import everything from one place.
export { isManagedAgentType };

// ─── Agent key (org_ns.workspace_ns.agent_slug) ──────────────────────────────

/**
 * Resolve the org + workspace namespaces for the current tenant scope in ONE
 * query (never per-agent — list must not N+1). Joins the workspace to its org
 * so both immutable namespaces come back together. Returns nulls only for a
 * scope whose rows predate the namespace backfill (defensive; post-migration
 * every org/workspace has a namespace).
 */
export async function resolveNamespacePrefix(
  tx: Tx,
  orgId: string,
  workspaceId: string,
): Promise<{ orgNamespace: string | null; workspaceNamespace: string | null }> {
  const [row] = await tx
    .select({
      orgNamespace: schema.organizations.namespace,
      workspaceNamespace: schema.workspaces.namespace,
    })
    .from(schema.workspaces)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.workspaces.orgId),
    )
    .where(
      and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.orgId, orgId),
      ),
    )
    .limit(1);
  return {
    orgNamespace: row?.orgNamespace ?? null,
    workspaceNamespace: row?.workspaceNamespace ?? null,
  };
}

/**
 * Compose the immutable global agent key `org_ns.workspace_ns.agent_slug`.
 * Returns null when either namespace is missing so the caller surfaces a
 * null agentKey rather than a malformed `..slug` string.
 */
export function composeAgentKey(
  orgNamespace: string | null,
  workspaceNamespace: string | null,
  slug: string,
): string | null {
  if (!orgNamespace || !workspaceNamespace) return null;
  return `${orgNamespace}.${workspaceNamespace}.${slug}`;
}

// ─────────────────────────────────────────────────────────────────────────────

/** A UUID v4/v7 in canonical hyphenated form. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface AgentRow {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  description: string | null;
  agentType: string;
  status: "draft" | "active" | "archived";
  deploymentStatus: "inactive" | "active";
  activeVersionId: string | null;
  /** https:// URL or "avatar:v1:<json>" designed-avatar string; null when unset. */
  avatarUrl: string | null;
  /** LLM-inferred plain-text description of what the agent does; null until summarized. */
  summary: string | null;
  /** SHA-256 of the config `summary` was derived from; null until summarized. */
  summaryChecksum: string | null;
}

const agentColumns = {
  id: schema.agents.id,
  publicId: schema.agents.publicId,
  slug: schema.agents.slug,
  name: schema.agents.name,
  description: schema.agents.description,
  agentType: schema.agents.agentType,
  status: schema.agents.status,
  deploymentStatus: schema.agents.deploymentStatus,
  activeVersionId: schema.agents.activeVersionId,
  avatarUrl: schema.agents.avatarUrl,
  summary: schema.agents.summary,
  summaryChecksum: schema.agents.summaryChecksum,
} as const;

/**
 * Resolve an agent by public id (agt_…), UUID, or slug — workspace-scoped.
 * Returns null when no live (non-deleted) agent matches.
 */
export async function resolveAgent(
  identifier: string,
  workspaceId: string,
  tx?: Tx,
): Promise<AgentRow | null> {
  const run = async (d: Tx): Promise<AgentRow | null> => {
    const matchColumn = isUuid(identifier)
      ? eq(schema.agents.id, identifier)
      : identifier.startsWith("agt_")
        ? eq(schema.agents.publicId, identifier)
        : eq(schema.agents.slug, identifier);

    const [row] = await d
      .select(agentColumns)
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, workspaceId),
          matchColumn,
          isNull(schema.agents.deletedAt),
        ),
      )
      .limit(1);
    return (row as AgentRow | undefined) ?? null;
  };
  return tx ? run(tx) : withTenantDb(run);
}
