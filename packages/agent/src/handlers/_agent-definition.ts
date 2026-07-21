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
  /** The agent's IAM identity (iam.principals kind='agent'); null for
   * agents created before principal provisioning shipped, if any survive. */
  principalId: string | null;
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
  principalId: schema.agents.principalId,
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

/**
 * An agent resolved for A2A skill addressing, with its active version's
 * instructions inlined so the caller (the A2A bridge) doesn't need a second
 * round trip to compose the per-skill system prompt.
 */
export interface AgentForA2A extends AgentRow {
  activeVersion: { id: string; instructions: string | null } | null;
}

/**
 * Resolve a workspace agent by slug for A2A skill addressing
 * (message.metadata.skillId — spec docs/specs/a2a-agent-identity/spec.md §3.1).
 *
 * Deliberately stricter than `resolveAgent`: matches by slug ONLY (skillId is
 * always the agent's slug, per the a2a.card.get skill listing), and requires
 * `status='active' AND deploymentStatus='active'` — the same gate
 * a2a.card.get uses to decide whether to list the skill at all, so a stale or
 * since-archived skillId can never resolve to a definition the card no longer
 * advertises. Returns null (never throws) when nothing matches — the A2A
 * bridge falls back to the generic chat baseline rather than failing the task.
 */
export async function resolveAgentForA2A(
  workspaceId: string,
  slug: string,
  tx?: Tx,
): Promise<AgentForA2A | null> {
  const run = async (d: Tx): Promise<AgentForA2A | null> => {
    const [row] = await d
      .select({
        ...agentColumns,
        activeVersionId2: schema.agentVersions.id,
        activeVersionConfig: schema.agentVersions.config,
      })
      .from(schema.agents)
      .leftJoin(
        schema.agentVersions,
        eq(schema.agentVersions.id, schema.agents.activeVersionId),
      )
      .where(
        and(
          eq(schema.agents.workspaceId, workspaceId),
          eq(schema.agents.slug, slug),
          eq(schema.agents.status, "active"),
          eq(schema.agents.deploymentStatus, "active"),
          isNull(schema.agents.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    const config = (row.activeVersionConfig ?? null) as {
      instructions?: string;
    } | null;
    return {
      id: row.id,
      publicId: row.publicId,
      slug: row.slug,
      name: row.name,
      description: row.description,
      agentType: row.agentType,
      // Both are already gated to these exact values by the WHERE clause above.
      status: row.status as "active",
      deploymentStatus: row.deploymentStatus as "active",
      activeVersionId: row.activeVersionId,
      avatarUrl: row.avatarUrl,
      summary: row.summary,
      summaryChecksum: row.summaryChecksum,
      principalId: row.principalId,
      activeVersion: row.activeVersionId2
        ? {
            id: row.activeVersionId2,
            instructions: config?.instructions ?? null,
          }
        : null,
    };
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
