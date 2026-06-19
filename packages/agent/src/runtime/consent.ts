// consent.ts — first-use consent + scope grants for external MCP tools (OXA-816).
//
// The FIRST time an agent invokes a `mcp.<serverId>.<tool>` for a given
// workspace+user+server+tool, the runtime pauses (HITL) and renders a consent
// card. The user's approve/deny lands in mcp.consents; subsequent calls within
// the grant TTL run inline without pausing. A workspace policy may seed a
// tool-group pre-grant with tool_name = '*'.
//
// This mirrors approval.ts: createConsentRequest writes an agent.approval_requests
// row (reusing the HITL machinery so the consent card is just an approval card
// keyed by the consent capability), and waitForApproval blocks on the same
// PG-NOTIFY channel until the agent.mcp.consent.resolve handler resolves it.
// recordConsent persists the durable grant so the SECOND call is inline.

import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";

// Default grant TTL: a first-use consent is valid for 30 days before the user
// is asked again. Workspace pre-grants (tool_name='*') are written with a NULL
// expiry by the policy seeder and never age out here.
export const DEFAULT_CONSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Wildcard tool name: a workspace pre-grant covering every tool on a server.
export const CONSENT_WILDCARD = "*";

/**
 * Thrown by checkConsent's callers when no active grant exists and consent must
 * be solicited before the transport runs. The materialize-tools closure catches
 * the *absence* of consent by inspecting checkConsent's result, not this error;
 * ConsentRequiredError is exported for callers (and tests) that prefer a typed
 * signal.
 */
export class ConsentRequiredError extends Error {
  readonly serverId: string;
  readonly toolName: string;
  readonly prompt: string;
  constructor(serverId: string, toolName: string, prompt: string) {
    super(`consent required for mcp.${serverId}.${toolName}`);
    this.name = "ConsentRequiredError";
    this.serverId = serverId;
    this.toolName = toolName;
    this.prompt = prompt;
  }
}

export type ConsentStatus = "granted" | "denied";

export interface ConsentDecision {
  status: ConsentStatus;
  /** True when the row is an unexpired wildcard or per-tool grant. */
  active: boolean;
}

/**
 * Resolve the effective consent for (workspace, user, server, tool).
 *
 * Lookup order (most specific wins):
 *   1. A per-tool row for `toolName`.
 *   2. A wildcard pre-grant (toolName = '*').
 *
 * A row is "active" when status='granted' AND (expires_at IS NULL OR > now()).
 * A denied row is returned as { status:'denied', active:true } so the caller
 * can short-circuit without re-prompting. Returns null when no row matches —
 * the caller must solicit consent.
 */
export async function checkConsent(
  ctx: CapabilityContext,
  userId: string,
  serverId: string,
  toolName: string,
): Promise<ConsentDecision | null> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        toolName: schema.mcpConsents.toolName,
        status: schema.mcpConsents.status,
        expiresAt: schema.mcpConsents.expiresAt,
      })
      .from(schema.mcpConsents)
      .where(
        and(
          eq(schema.mcpConsents.orgId, ctx.orgId),
          eq(schema.mcpConsents.workspaceId, ctx.workspaceId),
          eq(schema.mcpConsents.userId, userId),
          eq(schema.mcpConsents.mcpServerId, serverId),
          or(
            eq(schema.mcpConsents.toolName, toolName),
            eq(schema.mcpConsents.toolName, CONSENT_WILDCARD),
          ),
          // Only unexpired rows are active. NULL expiry never expires.
          or(
            isNull(schema.mcpConsents.expiresAt),
            sql`${schema.mcpConsents.expiresAt} > now()`,
          ),
        ),
      ),
  );
  if (rows.length === 0) return null;
  // Prefer an exact per-tool match over the wildcard.
  const exact = rows.find((r) => r.toolName === toolName);
  const chosen = exact ?? rows[0]!;
  return {
    status: chosen.status as ConsentStatus,
    active: true,
  };
}

export interface RecordConsentArgs {
  orgId: string;
  workspaceId: string;
  userId: string;
  serverId: string;
  toolName: string;
  status: ConsentStatus;
  /** Override the default TTL. Pass null for a non-expiring grant (pre-grant). */
  ttlMs?: number | null;
}

/**
 * Persist (upsert) a durable consent decision so subsequent calls run inline.
 * Upserts on the (workspace, user, server, tool) unique key — a later decision
 * overrides an earlier one (e.g. a user re-grants after a denial).
 */
export async function recordConsent(args: RecordConsentArgs): Promise<{ consentId: string }> {
  const now = new Date();
  const expiresAt =
    args.ttlMs === null
      ? null
      : new Date(now.getTime() + (args.ttlMs ?? DEFAULT_CONSENT_TTL_MS));
  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.mcpConsents)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        mcpServerId: args.serverId,
        toolName: args.toolName,
        status: args.status,
        grantedAt: args.status === "granted" ? now : null,
        deniedAt: args.status === "denied" ? now : null,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.mcpConsents.workspaceId,
          schema.mcpConsents.userId,
          schema.mcpConsents.mcpServerId,
          schema.mcpConsents.toolName,
        ],
        set: {
          status: args.status,
          grantedAt: args.status === "granted" ? now : null,
          deniedAt: args.status === "denied" ? now : null,
          expiresAt,
          updatedAt: now,
        },
      })
      .returning({ id: schema.mcpConsents.id }),
  );
  if (!row) throw new Error("mcp.consents upsert failed");
  return { consentId: row.id };
}

export interface ListConsentsArgs {
  orgId: string;
  workspaceId: string;
  userId?: string | null;
}

export interface ConsentRow {
  publicId: string;
  userId: string;
  mcpServerId: string;
  toolName: string;
  status: ConsentStatus;
  grantedAt: string | null;
  deniedAt: string | null;
  expiresAt: string | null;
}

/** List consent grants in the active workspace (optionally filtered by user). */
export async function listConsents(args: ListConsentsArgs): Promise<ConsentRow[]> {
  const conds = [
    eq(schema.mcpConsents.orgId, args.orgId),
    eq(schema.mcpConsents.workspaceId, args.workspaceId),
  ];
  if (args.userId) conds.push(eq(schema.mcpConsents.userId, args.userId));
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.mcpConsents.publicId,
        userId: schema.mcpConsents.userId,
        mcpServerId: schema.mcpConsents.mcpServerId,
        toolName: schema.mcpConsents.toolName,
        status: schema.mcpConsents.status,
        grantedAt: schema.mcpConsents.grantedAt,
        deniedAt: schema.mcpConsents.deniedAt,
        expiresAt: schema.mcpConsents.expiresAt,
      })
      .from(schema.mcpConsents)
      .where(and(...conds))
      .orderBy(desc(schema.mcpConsents.createdAt)),
  );
  return rows.map((r) => ({
    publicId: r.publicId,
    userId: r.userId,
    mcpServerId: r.mcpServerId,
    toolName: r.toolName,
    status: r.status as ConsentStatus,
    grantedAt: r.grantedAt ? r.grantedAt.toISOString() : null,
    deniedAt: r.deniedAt ? r.deniedAt.toISOString() : null,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  }));
}
