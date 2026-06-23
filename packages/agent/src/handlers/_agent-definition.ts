// Shared row-resolution helpers for the agent-definition / trigger handlers.
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
    super(
      `Agent "${identifier}" is managed by Oxagen and cannot be modified.`,
    );
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

export interface TriggerRow {
  id: string;
  publicId: string;
  agentId: string;
  /** The `agentType` of the parent agent — used to enforce managed-agent guards. */
  agentType: string;
}

/**
 * Resolve a trigger by public id (atr_…) or UUID — workspace-scoped, live only.
 * Joins the parent `agents` row to surface `agentType` so mutating handlers can
 * call the managed-agent guard without an extra round-trip.
 */
export async function resolveTrigger(
  identifier: string,
  workspaceId: string,
  tx?: Tx,
): Promise<TriggerRow | null> {
  const run = async (d: Tx): Promise<TriggerRow | null> => {
    const matchColumn = isUuid(identifier)
      ? eq(schema.agentTriggers.id, identifier)
      : eq(schema.agentTriggers.publicId, identifier);

    const [row] = await d
      .select({
        id: schema.agentTriggers.id,
        publicId: schema.agentTriggers.publicId,
        agentId: schema.agentTriggers.agentId,
        agentType: schema.agents.agentType,
      })
      .from(schema.agentTriggers)
      .innerJoin(
        schema.agents,
        and(
          eq(schema.agentTriggers.agentId, schema.agents.id),
          isNull(schema.agents.deletedAt),
        ),
      )
      .where(
        and(
          eq(schema.agentTriggers.workspaceId, workspaceId),
          matchColumn,
          isNull(schema.agentTriggers.deletedAt),
        ),
      )
      .limit(1);
    return (row as TriggerRow | undefined) ?? null;
  };
  return tx ? run(tx) : withTenantDb(run);
}
