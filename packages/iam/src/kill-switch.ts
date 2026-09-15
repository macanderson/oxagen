// kill-switch.ts — kill switches on iam.emergency_denies (MC spec §6.11,
// ADR-065, #2958).
//
// A kill switch is an emergency deny that names what it stops: `target_kind`
// and `target_id` on the row, beside the typed deny the live check matches
// (`capability_id` for a tool version, a `resource_scope_digest` over
// `{ kind, id }` for everything else — resource-scope.ts). Flipping one on
// inserts an active row; flipping it off deactivates that row and keeps it,
// so the audit trail of what was stopped when survives. A partial unique
// index holds one active row per target (emergency_denies_active_target_
// {org,ws}_uidx): the on flip inserts ON CONFLICT DO NOTHING against it, so
// two concurrent on-flips write one row, and the off flip deactivates every
// active row the target has rather than one it read first. The AFTER trigger
// on the table (migration 20260813110000) bumps the deny generation in the
// same transaction as either write, which is what makes a flip take effect at
// the next call boundary: every cached allow is keyed by the generation it
// was computed under.
//
// This module owns the reads and writes; the two handlers
// (packages/handlers/src/kill_switch.{set,list}.ts) resolve public ids and
// roles, and the tool gateway's gate (packages/agent/src/runtime/
// kill-switch-gate.ts) matches the active rows against each call.

import { schema, type Tx } from "@oxagen/database";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  matchEmergencyDeny,
  type ActiveEmergencyDeny,
} from "./live-agent-run-authorization";
import { implicitScopeDigests, resourceScopeDigestOf } from "./resource-scope";

export type KillSwitchTargetKind =
  | "tool_version"
  | "tool_server"
  | "connection"
  | "agent"
  | "operator"
  | "workspace"
  | "org"
  | "class";

/** Precedence when several switches reach one call: the recorded decision order (INV-10). */
const KILL_SWITCH_PRECEDENCE: readonly KillSwitchTargetKind[] = [
  "tool_version",
  "tool_server",
  "connection",
  "class",
  "agent",
  "operator",
  "workspace",
  "org",
];

export interface KillSwitchRow {
  readonly id: string;
  readonly publicId: string;
  readonly targetKind: KillSwitchTargetKind;
  /** The public id the switch was flipped with, or the consequence tag. */
  readonly targetId: string;
  readonly scopeKind: "org" | "workspace";
  readonly workspaceId: string | null;
  readonly capabilityId: string | null;
  readonly resourceScopeDigest: string | null;
  readonly principalId: string | null;
  readonly reason: string;
  readonly active: boolean;
  readonly activatedAt: Date;
  readonly deactivatedAt: Date | null;
  readonly flippedByUserId: string | null;
  readonly updatedByUserId: string | null;
}

const KINDS = new Set<string>(KILL_SWITCH_PRECEDENCE);

function rowOf(r: {
  id: string;
  publicId: string;
  targetKind: string | null;
  targetId: string | null;
  scopeKind: string;
  workspaceId: string | null;
  capabilityId: string | null;
  resourceScopeDigest: string | null;
  principalId: string | null;
  reason: string;
  active: boolean;
  activatedAt: Date;
  deactivatedAt: Date | null;
  flippedByUserId: string | null;
  updatedByUserId: string | null;
}): KillSwitchRow {
  if (
    r.targetKind === null ||
    r.targetId === null ||
    !KINDS.has(r.targetKind) ||
    (r.scopeKind !== "org" && r.scopeKind !== "workspace")
  ) {
    // The query selects target_kind IS NOT NULL and the CHECK constraints
    // bound both columns, so this is a row written outside them.
    throw new RangeError(`emergency_denies ${r.publicId}: not a kill switch`);
  }
  return {
    id: r.id,
    publicId: r.publicId,
    targetKind: r.targetKind as KillSwitchTargetKind,
    targetId: r.targetId,
    scopeKind: r.scopeKind,
    workspaceId: r.workspaceId,
    capabilityId: r.capabilityId,
    resourceScopeDigest: r.resourceScopeDigest,
    principalId: r.principalId,
    reason: r.reason,
    active: r.active,
    activatedAt: r.activatedAt,
    deactivatedAt: r.deactivatedAt,
    flippedByUserId: r.flippedByUserId,
    updatedByUserId: r.updatedByUserId,
  };
}

const columns = {
  id: schema.emergencyDenies.id,
  publicId: schema.emergencyDenies.publicId,
  targetKind: schema.emergencyDenies.targetKind,
  targetId: schema.emergencyDenies.targetId,
  scopeKind: schema.emergencyDenies.scopeKind,
  workspaceId: schema.emergencyDenies.workspaceId,
  capabilityId: schema.emergencyDenies.capabilityId,
  resourceScopeDigest: schema.emergencyDenies.resourceScopeDigest,
  principalId: schema.emergencyDenies.principalId,
  reason: schema.emergencyDenies.reason,
  active: schema.emergencyDenies.active,
  activatedAt: schema.emergencyDenies.activatedAt,
  deactivatedAt: schema.emergencyDenies.deactivatedAt,
  flippedByUserId: schema.emergencyDenies.flippedByUserId,
  updatedByUserId: schema.emergencyDenies.updatedByUserId,
};

/** The org-wide rows and this workspace's rows. */
function reaching(orgId: string, workspaceId: string | null) {
  return and(
    eq(schema.emergencyDenies.orgId, orgId),
    sql`${schema.emergencyDenies.targetKind} IS NOT NULL`,
    workspaceId === null
      ? isNull(schema.emergencyDenies.workspaceId)
      : or(
          isNull(schema.emergencyDenies.workspaceId),
          eq(schema.emergencyDenies.workspaceId, workspaceId),
        ),
  );
}

/**
 * Every kill switch reaching the scope, newest first: org-wide switches and
 * the workspace's own, on and off unless `onlyOn`.
 */
export async function readKillSwitches(
  tx: Tx,
  args: {
    orgId: string;
    workspaceId: string | null;
    onlyOn: boolean;
    limit: number;
  },
): Promise<KillSwitchRow[]> {
  const rows = await tx
    .select(columns)
    .from(schema.emergencyDenies)
    .where(
      and(
        reaching(args.orgId, args.workspaceId),
        args.onlyOn ? eq(schema.emergencyDenies.active, true) : undefined,
      ),
    )
    .orderBy(
      desc(schema.emergencyDenies.activatedAt),
      desc(schema.emergencyDenies.id),
    )
    .limit(args.limit);
  return rows.map(rowOf);
}

/** The switches currently on in the scope, in precedence order. */
export async function readActiveKillSwitches(
  tx: Tx,
  args: { orgId: string; workspaceId: string | null },
): Promise<KillSwitchRow[]> {
  const rows = await tx
    .select(columns)
    .from(schema.emergencyDenies)
    .where(
      and(
        reaching(args.orgId, args.workspaceId),
        eq(schema.emergencyDenies.active, true),
      ),
    );
  return sortByPrecedence(rows.map(rowOf));
}

export function sortByPrecedence(
  rows: readonly KillSwitchRow[],
): KillSwitchRow[] {
  const rank = new Map(KILL_SWITCH_PRECEDENCE.map((k, i) => [k, i] as const));
  return [...rows].sort(
    (a, b) => (rank.get(a.targetKind) ?? 99) - (rank.get(b.targetKind) ?? 99),
  );
}

/** What a switch flipped on denies at the call boundary. */
export type KillSwitchDeny =
  | { readonly kind: "capability"; readonly capabilityId: string }
  | { readonly kind: "resource_scope"; readonly digest: string };

interface FlipKillSwitchOnArgs {
  orgId: string;
  /** Null for an org-wide switch (org, class). */
  workspaceId: string | null;
  target: { kind: KillSwitchTargetKind; id: string };
  deny: KillSwitchDeny;
  reason: string;
  userId: string | null;
}

/**
 * Flip a switch on: insert the active deny row. The insert is ON CONFLICT DO
 * NOTHING against the partial unique index over the target's active row, so
 * when one is already on — from before, or from a concurrent flip — nothing
 * is written and that row's id is returned with `changed: false`. Runs in the
 * caller's transaction; the table's trigger bumps the deny generation there.
 */
export async function flipKillSwitchOn(
  tx: Tx,
  args: FlipKillSwitchOnArgs,
): Promise<{ publicId: string; changed: boolean }> {
  const d = schema.emergencyDenies;
  const [row] = await tx
    .insert(d)
    .values({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      scopeKind: args.workspaceId === null ? "org" : "workspace",
      denyKind: args.deny.kind,
      capabilityId:
        args.deny.kind === "capability" ? args.deny.capabilityId : null,
      resourceScopeDigest:
        args.deny.kind === "resource_scope" ? args.deny.digest : null,
      principalId: null,
      targetKind: args.target.kind,
      targetId: args.target.id,
      flippedByUserId: args.userId,
      reason: args.reason,
      active: true,
      createdByUserId: args.userId,
      updatedByUserId: args.userId,
    })
    .onConflictDoNothing(
      args.workspaceId === null
        ? {
            target: [d.orgId, d.targetKind, d.targetId],
            where: sql`active = true AND workspace_id IS NULL`,
          }
        : {
            target: [d.orgId, d.workspaceId, d.targetKind, d.targetId],
            where: sql`active = true AND workspace_id IS NOT NULL`,
          },
    )
    .returning({ publicId: d.publicId });
  if (row) return { publicId: row.publicId, changed: true };
  const [existing] = await tx
    .select({ publicId: d.publicId })
    .from(d)
    .where(activeTarget(args))
    .limit(1);
  if (!existing) {
    throw new Error(
      "emergency_denies INSERT conflicted with no active row for the target",
    );
  }
  return { publicId: existing.publicId, changed: false };
}

/**
 * Flip a switch off: deactivate every active row for the target, keeping
 * them, with who cleared it and why. `publicId` is null and `changed` false
 * when no switch for the target is on.
 */
export async function flipKillSwitchOff(
  tx: Tx,
  args: {
    orgId: string;
    workspaceId: string | null;
    target: { kind: KillSwitchTargetKind; id: string };
    reason: string;
    userId: string | null;
  },
): Promise<{ publicId: string | null; changed: boolean }> {
  const rows = await tx
    .update(schema.emergencyDenies)
    .set({
      active: false,
      clearedReason: args.reason,
      deactivatedAt: sql`now()`,
      updatedAt: sql`now()`,
      updatedByUserId: args.userId,
    })
    .where(activeTarget(args))
    .returning({ publicId: schema.emergencyDenies.publicId });
  const [first] = rows;
  return first
    ? { publicId: first.publicId, changed: true }
    : { publicId: null, changed: false };
}

/** The target's active row(s) in the scope the switch was written under. */
function activeTarget(args: {
  orgId: string;
  workspaceId: string | null;
  target: { kind: KillSwitchTargetKind; id: string };
}) {
  return and(
    eq(schema.emergencyDenies.orgId, args.orgId),
    args.workspaceId === null
      ? isNull(schema.emergencyDenies.workspaceId)
      : eq(schema.emergencyDenies.workspaceId, args.workspaceId),
    eq(schema.emergencyDenies.targetKind, args.target.kind),
    eq(schema.emergencyDenies.targetId, args.target.id),
    eq(schema.emergencyDenies.active, true),
  );
}

// ---------------------------------------------------------------------------
// Matching a call against the switches that are on
// ---------------------------------------------------------------------------

/** What is known about one tool call at the gateway. */
interface KillSwitchCallFacts {
  readonly orgId: string;
  readonly workspaceId: string | null;
  /** The capability id the call is governed under (`mcp.<server>.<tool>` for an external tool). */
  readonly capabilityId: string;
  /** The external server's internal id, for an MCP tool. */
  readonly serverId?: string | null;
  /** The stored credential (`mcp.credentials.id`) the server was reached with. */
  readonly connectionId?: string | null;
  /** The tool version's consequence tags, from its classification. */
  readonly consequenceTags?: readonly string[];
  readonly agentId?: string | null;
  readonly operatorUserId?: string | null;
  readonly principalIds?: readonly string[];
}

/** Every `{ kind, id }` digest a call answers to. */
export function callScopeDigests(facts: KillSwitchCallFacts): string[] {
  const digests = implicitScopeDigests({
    orgId: facts.orgId,
    workspaceId: facts.workspaceId,
    agentId: facts.agentId ?? null,
    operatorUserId: facts.operatorUserId ?? null,
  });
  if (facts.serverId) {
    digests.push(
      resourceScopeDigestOf({ kind: "tool_server", id: facts.serverId }),
    );
  }
  if (facts.connectionId) {
    digests.push(
      resourceScopeDigestOf({ kind: "connection", id: facts.connectionId }),
    );
  }
  for (const tag of facts.consequenceTags ?? []) {
    digests.push(resourceScopeDigestOf({ kind: "class", id: tag }));
  }
  return digests;
}

/**
 * The first switch, in precedence order, that stops this call; null when the
 * call is open. Pure: the caller supplies the active rows it read.
 */
export function matchKillSwitch(
  active: readonly KillSwitchRow[],
  facts: KillSwitchCallFacts,
): KillSwitchRow | null {
  const denies: ActiveEmergencyDeny[] = sortByPrecedence(active).map((r) => ({
    publicId: r.publicId,
    denyKind: r.capabilityId !== null ? "capability" : "resource_scope",
    capabilityId: r.capabilityId,
    resourceScopeDigest: r.resourceScopeDigest,
    principalId: r.principalId,
    reason: r.reason,
  }));
  const hit = matchEmergencyDeny(denies, {
    capability: facts.capabilityId,
    resourceScopeDigest: null,
    scopeDigests: callScopeDigests(facts),
    principalIds: facts.principalIds ?? [],
  });
  if (hit === null) return null;
  return active.find((r) => r.publicId === hit.publicId) ?? null;
}
