// authorization-snapshot.ts — build and persist the PINNED grant ceiling a
// governed run is admitted under (docs/specs/run-evidence-ingress/spec.md;
// 02-run-attempt-foundation-plan.md Task 5).
//
// One `iam.authorization_snapshots` row (`ras_…`) per admitted run. It records
// the human ∩ agent ceiling as it stood at ONE instant, preserving assignment
// ids, role ids, conditions, resource scopes, and every per-binding expiry —
// deliberately NOT flattened into a capability allowlist, because a flat list
// can be silently refreshed from later grants and loses the per-binding expiry
// the live check re-evaluates against.
//
// ── Why REPEATABLE READ is load-bearing ─────────────────────────────────────
//
// Constructing a ceiling means reading, in sequence: both principals' status,
// the org's roles, both principals' role assignments, those roles' grants, and
// the org + workspace deny-generation counters. Under READ COMMITTED each of
// those statements sees a DIFFERENT snapshot. A revocation committing halfway
// through would let the pre-revocation grant land in the ceiling while the
// post-revocation generation bump also lands — producing a snapshot that never
// existed at any instant, and one whose generation says "current" about
// authority that is already gone.
//
// `withRepeatableReadTenantDb` (packages/database/src/tenant.ts, added for
// exactly this) puts the whole read on one MVCC snapshot, so the ceiling and
// its generation vector are consistent by construction. Every read in this
// module goes through it; there is no second path.
//
// ── Two constructors, deliberately asymmetric ───────────────────────────────
//
//   createAgentRunAuthorizationSnapshot   ROOT run. Resolves current authority
//                                         once and pins it.
//   createChildRunAuthorizationSnapshot   SUBAGENT run. `still-valid parent
//                                         ceiling ∩ current live authority ∩
//                                         child narrowing`. It never resolves
//                                         current grants afresh, so a grant
//                                         issued after the parent was admitted
//                                         cannot enter a child, and a child can
//                                         neither outlive nor widen its parent.

import { schema, type Tx } from "@oxagen/database";
// The repeatable-read helper is deliberately NOT on @oxagen/database's barrel:
// it is narrow-purpose (see its own doc comment) and the subpath import keeps
// every caller greppable.
import { withRepeatableReadTenantDb } from "@oxagen/database/tenant";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  canonicalGrantCeiling,
  nextValidityBoundary,
  type AgentRunAuthorizationBinding,
  type AuthorizationGrantCeiling,
  type ChildRunNarrowingPolicy,
  type DenyGenerationVector,
  type PinnedRole,
  type PinnedRoleAssignment,
  type PinnedRoleGrant,
} from "@oxagen/oxagen/iam";
import type { CapabilityEffect } from "@oxagen/oxagen";
import { digestJcs } from "@oxagen/run-evidence";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A snapshot could not be built. Always fatal for the run being admitted: an
 * agent with no pinned ceiling has no authority at all, so there is nothing to
 * degrade gracefully to.
 */
export class AuthorizationSnapshotError extends Error {
  constructor(
    readonly code:
      | "principal_not_found"
      | "principal_inactive"
      | "parent_snapshot_not_found"
      | "parent_expired"
      | "insert_failed",
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationSnapshotError";
  }
}

// ---------------------------------------------------------------------------
// Live authority — the rows a ceiling is built from, read under one snapshot
// ---------------------------------------------------------------------------

/** One live role assignment, with every column the ceiling must preserve. */
export interface LiveRoleAssignment {
  readonly assignmentId: string;
  readonly principalId: string;
  readonly roleId: string;
  readonly workspaceId: string | null;
  readonly assignedAt: Date;
  readonly expiresAt: Date | null;
}

export interface LiveRoleGrant {
  readonly grantId: string;
  readonly roleId: string;
  readonly capabilityId: string;
  readonly effect: CapabilityEffect;
  readonly conditions: unknown | null;
}

export interface LivePrincipalStatus {
  readonly principalId: string;
  readonly status: "active" | "suspended" | "deleted";
}

/**
 * Everything a ceiling (or a live re-check) needs, all read on ONE MVCC
 * snapshot. The generation vector is part of the same read on purpose: a
 * generation observed in a different transaction than the grants tells you
 * nothing about those grants.
 */
export interface LiveAuthorityState {
  readonly roles: readonly PinnedRole[];
  readonly assignments: readonly LiveRoleAssignment[];
  readonly roleGrants: readonly LiveRoleGrant[];
  readonly principals: readonly LivePrincipalStatus[];
  readonly denyGeneration: DenyGenerationVector;
  readonly readAt: Date;
}

/**
 * Read the org's roles, both ceiling principals' live assignments, those roles'
 * grants, both principals' status, and the deny-generation vector.
 *
 * MUST be called inside a `withRepeatableReadTenantDb` transaction — every
 * exported entry point in this module does that, and `readLiveAuthority` takes
 * the `tx` rather than opening its own so a caller cannot accidentally split
 * the read across two snapshots.
 *
 * Expired and soft-deleted assignments are NOT filtered here: the caller
 * decides. The ceiling constructor drops already-expired ones (they were never
 * authority); the live checker needs to see what is currently valid. Both need
 * the raw `expiresAt`, which is why it is projected rather than compared in SQL.
 */
export async function readLiveAuthority(
  tx: Tx,
  args: {
    orgId: string;
    workspaceId: string;
    principalIds: readonly string[];
  },
): Promise<LiveAuthorityState> {
  const { orgId, workspaceId, principalIds } = args;
  const ids = [...principalIds];

  const roleRows = await tx
    .select({
      id: schema.roles.id,
      name: schema.roles.name,
      scopeKind: schema.roles.scopeKind,
      isSystemDefault: schema.roles.isSystemDefault,
    })
    .from(schema.roles)
    .where(eq(schema.roles.orgId, orgId));

  const roleIds = roleRows.map((r) => r.id);

  const grantRows =
    roleIds.length > 0
      ? await tx
          .select({
            id: schema.roleGrants.id,
            roleId: schema.roleGrants.roleId,
            capabilityId: schema.roleGrants.capabilityId,
            effect: schema.roleGrants.effect,
            conditionsJsonb: schema.roleGrants.conditionsJsonb,
          })
          .from(schema.roleGrants)
          .where(inArray(schema.roleGrants.roleId, roleIds))
      : [];

  // Soft-deleted assignments are excluded (a deleted assignment is not
  // authority) but EXPIRED ones are kept, so the ceiling can pin the expiry
  // and the live check can re-evaluate it against the original binding rather
  // than against a row that silently vanished from a WHERE clause.
  const assignmentRows =
    ids.length > 0
      ? await tx
          .select({
            id: schema.principalRoleAssignments.id,
            principalId: schema.principalRoleAssignments.principalId,
            roleId: schema.principalRoleAssignments.roleId,
            workspaceId: schema.principalRoleAssignments.workspaceId,
            assignedAt: schema.principalRoleAssignments.assignedAt,
            expiresAt: schema.principalRoleAssignments.expiresAt,
          })
          .from(schema.principalRoleAssignments)
          .where(
            and(
              inArray(schema.principalRoleAssignments.principalId, ids),
              eq(schema.principalRoleAssignments.orgId, orgId),
              isNull(schema.principalRoleAssignments.deletedAt),
              or(
                isNull(schema.principalRoleAssignments.workspaceId),
                eq(schema.principalRoleAssignments.workspaceId, workspaceId),
              ),
            ),
          )
      : [];

  const principalRows =
    ids.length > 0
      ? await tx
          .select({
            id: schema.principals.id,
            status: schema.principals.status,
          })
          .from(schema.principals)
          .where(inArray(schema.principals.id, ids))
      : [];

  const denyGeneration = await readDenyGenerationVector(tx, {
    orgId,
    workspaceId,
  });

  return {
    roles: roleRows.map((r) => ({
      roleId: r.id,
      name: r.name,
      scopeKind: r.scopeKind === "org" ? "org" : "workspace",
      isSystemDefault: r.isSystemDefault,
    })),
    assignments: assignmentRows.map((a) => ({
      assignmentId: a.id,
      principalId: a.principalId,
      roleId: a.roleId,
      workspaceId: a.workspaceId,
      assignedAt: a.assignedAt,
      expiresAt: a.expiresAt,
    })),
    roleGrants: grantRows.map((g) => ({
      grantId: g.id,
      roleId: g.roleId,
      capabilityId: g.capabilityId,
      effect: g.effect as CapabilityEffect,
      conditions: g.conditionsJsonb ?? null,
    })),
    principals: principalRows.map((p) => ({
      principalId: p.id,
      status: p.status as LivePrincipalStatus["status"],
    })),
    denyGeneration,
    readAt: new Date(),
  };
}

/**
 * Read the org and workspace deny-generation counters.
 *
 * A missing row means the scope has never been bumped, so its generation is 0.
 * That is not a fallback for convenience — the application role holds SELECT
 * only on `iam.authorization_deny_generations` and cannot insert a row, so 0 is
 * the only value a never-mutated scope can report, and it is strictly lower
 * than any real generation (the trigger's first INSERT writes 1).
 */
export async function readDenyGenerationVector(
  tx: Tx,
  args: { orgId: string; workspaceId: string | null },
): Promise<DenyGenerationVector> {
  const rows = await tx
    .select({
      workspaceId: schema.authorizationDenyGenerations.workspaceId,
      generation: schema.authorizationDenyGenerations.generation,
    })
    .from(schema.authorizationDenyGenerations)
    .where(
      and(
        eq(schema.authorizationDenyGenerations.orgId, args.orgId),
        args.workspaceId === null
          ? isNull(schema.authorizationDenyGenerations.workspaceId)
          : or(
              isNull(schema.authorizationDenyGenerations.workspaceId),
              eq(
                schema.authorizationDenyGenerations.workspaceId,
                args.workspaceId,
              ),
            ),
      ),
    );

  let org = 0;
  let workspace = 0;
  for (const row of rows) {
    if (row.workspaceId === null) org = Number(row.generation);
    else workspace = Number(row.generation);
  }
  return { org, workspace };
}

// ---------------------------------------------------------------------------
// Ceiling construction
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

/**
 * Project live rows into a canonical ceiling.
 *
 * Assignments already expired at `now` are dropped: they were not authority at
 * admission, so pinning them would be pinning a lie. Assignments expiring LATER
 * are kept WITH their expiry so the live check can retire them on schedule.
 */
function buildCeiling(args: {
  initiatingPrincipalId: string;
  agentPrincipalId: string;
  live: LiveAuthorityState;
  now: Date;
  parentSnapshotId: string | null;
  narrowing: ChildRunNarrowingPolicy | null;
}): AuthorizationGrantCeiling {
  const nowMs = args.now.getTime();

  const assignments: PinnedRoleAssignment[] = args.live.assignments
    .filter((a) => a.expiresAt === null || a.expiresAt.getTime() > nowMs)
    .map((a) => ({
      assignmentId: a.assignmentId,
      principalId: a.principalId,
      roleId: a.roleId,
      workspaceId: a.workspaceId,
      assignedAt: toIso(a.assignedAt),
      expiresAt: a.expiresAt === null ? null : toIso(a.expiresAt),
    }));

  // Only roles some ceiling principal actually holds enter the ceiling — an
  // org role nobody in the intersection is assigned contributes no authority
  // and would only make the digest churn on unrelated role edits.
  const heldRoleIds = new Set(assignments.map((a) => a.roleId));
  const roles: PinnedRole[] = args.live.roles.filter((r) =>
    heldRoleIds.has(r.roleId),
  );

  const roleGrants: PinnedRoleGrant[] = args.live.roleGrants
    .filter((g) => heldRoleIds.has(g.roleId))
    .map((g) => ({
      grantId: g.grantId,
      roleId: g.roleId,
      capabilityId: g.capabilityId,
      effect: g.effect,
      conditions: g.conditions,
    }));

  return {
    version: 1,
    initiatingPrincipalId: args.initiatingPrincipalId,
    agentPrincipalId: args.agentPrincipalId,
    roles,
    assignments,
    roleGrants,
    parentSnapshotId: args.parentSnapshotId,
    narrowing: args.narrowing,
  };
}

/**
 * Digest the ceiling and the whole snapshot.
 *
 * `snapshotDigest` covers the ceiling digest PLUS the identity and generation
 * vector, so two runs admitted under the same authority at different
 * generations are distinguishable, and an exported snapshot can be verified
 * end-to-end without re-deriving the ceiling.
 */
function digestSnapshot(args: {
  ceiling: AuthorizationGrantCeiling;
  orgId: string;
  workspaceId: string;
  denyGeneration: DenyGenerationVector;
  nextValidityBoundaryAt: string | null;
  resolvedAt: string;
}): { grantCeilingDigest: string; snapshotDigest: string } {
  const grantCeilingDigest = digestJcs(canonicalGrantCeiling(args.ceiling));
  const snapshotDigest = digestJcs({
    version: 1,
    org_id: args.orgId,
    workspace_id: args.workspaceId,
    initiating_principal_id: args.ceiling.initiatingPrincipalId,
    agent_principal_id: args.ceiling.agentPrincipalId,
    grant_ceiling_digest: grantCeilingDigest,
    deny_generation: {
      org: args.denyGeneration.org,
      workspace: args.denyGeneration.workspace,
    },
    next_validity_boundary_at: args.nextValidityBoundaryAt,
    resolved_at: args.resolvedAt,
  });
  return { grantCeilingDigest, snapshotDigest };
}

function assertPrincipalsActive(
  live: LiveAuthorityState,
  required: readonly string[],
): void {
  for (const principalId of required) {
    const row = live.principals.find((p) => p.principalId === principalId);
    if (row === undefined) {
      throw new AuthorizationSnapshotError(
        "principal_not_found",
        `Principal ${principalId} does not exist in this org — cannot pin a ceiling for it.`,
      );
    }
    if (row.status !== "active") {
      throw new AuthorizationSnapshotError(
        "principal_inactive",
        `Principal ${principalId} is ${row.status} — a non-active principal cannot anchor a run ceiling.`,
      );
    }
  }
}

async function insertSnapshot(
  tx: Tx,
  args: {
    orgId: string;
    workspaceId: string;
    ceiling: AuthorizationGrantCeiling;
    grantCeilingDigest: string;
    snapshotDigest: string;
    denyGeneration: DenyGenerationVector;
    nextValidityBoundaryAt: string | null;
    resolvedAt: Date;
  },
): Promise<AgentRunAuthorizationBinding> {
  const [row] = await tx
    .insert(schema.authorizationSnapshots)
    .values({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      initiatingPrincipalId: args.ceiling.initiatingPrincipalId,
      agentPrincipalId: args.ceiling.agentPrincipalId,
      grantCeiling: canonicalGrantCeiling(args.ceiling),
      grantCeilingDigest: args.grantCeilingDigest,
      snapshotDigest: args.snapshotDigest,
      orgDenyGeneration: args.denyGeneration.org,
      workspaceDenyGeneration: args.denyGeneration.workspace,
      nextValidityBoundaryAt:
        args.nextValidityBoundaryAt === null
          ? null
          : new Date(args.nextValidityBoundaryAt),
      resolvedAt: args.resolvedAt,
    })
    .returning({
      id: schema.authorizationSnapshots.id,
      publicId: schema.authorizationSnapshots.publicId,
    });

  if (row === undefined) {
    throw new AuthorizationSnapshotError(
      "insert_failed",
      "authorization_snapshots INSERT returned no row — refusing to admit a run with an unrecorded ceiling.",
    );
  }

  return {
    snapshotId: row.id,
    snapshotPublicId: row.publicId,
    snapshotDigest: args.snapshotDigest,
    grantCeilingDigest: args.grantCeilingDigest,
    ceiling: args.ceiling,
    denyGenerationAtAdmission: args.denyGeneration,
    nextValidityBoundaryAt: args.nextValidityBoundaryAt,
    resolvedAt: toIso(args.resolvedAt),
  };
}

export interface CreateAgentRunAuthorizationSnapshotArgs {
  orgId: string;
  workspaceId: string;
  /**
   * The AUTHENTICATED initiating human's principal id. Never
   * `principals.parent_user_id` — that is the agent's creator, which is not
   * necessarily who authorized this execution.
   */
  initiatingPrincipalId: string;
  agentPrincipalId: string;
  /** Injectable for deterministic tests; defaults to now. */
  now?: Date;
}

/**
 * Resolve and pin a ROOT run's grant ceiling.
 *
 * The whole read — principals, roles, assignments, grants, and both generation
 * counters — plus the INSERT happen in ONE repeatable-read transaction, so the
 * persisted `(grant_ceiling, org_deny_generation, workspace_deny_generation)`
 * triple describes a state the database actually had.
 */
export async function createAgentRunAuthorizationSnapshot(
  args: CreateAgentRunAuthorizationSnapshotArgs,
): Promise<AgentRunAuthorizationBinding> {
  const now = args.now ?? new Date();
  return withRepeatableReadTenantDb(async (tx) => {
    const live = await readLiveAuthority(tx, {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      principalIds: [args.initiatingPrincipalId, args.agentPrincipalId],
    });

    assertPrincipalsActive(live, [
      args.initiatingPrincipalId,
      args.agentPrincipalId,
    ]);

    const ceiling = buildCeiling({
      initiatingPrincipalId: args.initiatingPrincipalId,
      agentPrincipalId: args.agentPrincipalId,
      live,
      now,
      parentSnapshotId: null,
      narrowing: null,
    });

    const boundary = nextValidityBoundary(ceiling, now);
    const resolvedAt = now;
    const { grantCeilingDigest, snapshotDigest } = digestSnapshot({
      ceiling,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      denyGeneration: live.denyGeneration,
      nextValidityBoundaryAt: boundary,
      resolvedAt: toIso(resolvedAt),
    });

    const binding = await insertSnapshot(tx, {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      ceiling,
      grantCeilingDigest,
      snapshotDigest,
      denyGeneration: live.denyGeneration,
      nextValidityBoundaryAt: boundary,
      resolvedAt,
    });

    logger.info(
      {
        snapshotPublicId: binding.snapshotPublicId,
        orgId: args.orgId,
        assignments: ceiling.assignments.length,
        roleGrants: ceiling.roleGrants.length,
        denyGeneration: live.denyGeneration,
      },
      "[iam] pinned agent-run authorization ceiling",
    );

    return binding;
  });
}

// ---------------------------------------------------------------------------
// Child (subagent) ceilings
// ---------------------------------------------------------------------------

/** Narrowness order — a smaller number is a narrower effect. Deny wins. */
const EFFECT_RANK: Record<CapabilityEffect, number> = {
  deny: 0,
  require_approval: 1,
  allow: 2,
};

function narrowerEffect(
  a: CapabilityEffect,
  b: CapabilityEffect,
): CapabilityEffect {
  return EFFECT_RANK[a] <= EFFECT_RANK[b] ? a : b;
}

export interface CreateChildRunAuthorizationSnapshotArgs {
  /** Internal UUID or `ras_…` public id of the parent snapshot. */
  parentSnapshotId: string;
  /** The additional ceiling the dispatching parent imposes. Narrowing only. */
  narrowingPolicy: ChildRunNarrowingPolicy;
  /**
   * Pre-read live authority, when the caller already holds one FROM THE SAME
   * repeatable-read transaction. Omit it and this function reads its own inside
   * the transaction it opens — which is the normal case and the safe default.
   */
  liveState?: LiveAuthorityState;
  now?: Date;
}

/**
 * Derive a child (subagent) ceiling as
 * `still-valid parent ceiling ∩ current live authority ∩ child narrowing`.
 *
 * Three separate narrowings, each of which can only shrink:
 *
 *  1. STILL-VALID PARENT — parent bindings whose own `expiresAt` has passed are
 *     dropped. This is where "a child cannot outlive its parent" starts.
 *  2. ∩ CURRENT LIVE — a parent binding whose assignment no longer exists (or
 *     whose principal is no longer active) is dropped; a grant whose live
 *     effect is narrower is taken at the narrower effect. Crucially, the
 *     intersection runs over the PARENT's bindings: a live assignment or grant
 *     absent from the parent is never added, so authority granted after the
 *     parent was admitted cannot leak into a child. The one exception is a live
 *     DENY grant on a role the child still holds — a deny narrows, so it is
 *     added.
 *  3. ∩ CHILD NARROWING — the dispatcher's capability allowlist and optional
 *     expiry. The effective boundary is the EARLIER of the parent's and the
 *     child's.
 *
 * The result is persisted as its own `ras_` row with `parent_snapshot_id` set,
 * so a subagent's authority is auditable independently of its parent's.
 */
export async function createChildRunAuthorizationSnapshot(
  args: CreateChildRunAuthorizationSnapshotArgs,
): Promise<AgentRunAuthorizationBinding> {
  const now = args.now ?? new Date();
  const nowMs = now.getTime();

  return withRepeatableReadTenantDb(async (tx) => {
    const isPublicId = args.parentSnapshotId.startsWith("ras_");
    const [parentRow] = await tx
      .select()
      .from(schema.authorizationSnapshots)
      .where(
        isPublicId
          ? eq(schema.authorizationSnapshots.publicId, args.parentSnapshotId)
          : eq(schema.authorizationSnapshots.id, args.parentSnapshotId),
      )
      .limit(1);

    if (parentRow === undefined) {
      throw new AuthorizationSnapshotError(
        "parent_snapshot_not_found",
        `Parent authorization snapshot ${args.parentSnapshotId} not found — a child ceiling cannot be derived from nothing.`,
      );
    }

    const parentCeiling = parentRow.grantCeiling as unknown;
    const parent = parseStoredCeiling(parentCeiling);

    if (
      parentRow.nextValidityBoundaryAt !== null &&
      parentRow.nextValidityBoundaryAt.getTime() <= nowMs
    ) {
      // The parent's own earliest binding has already expired. Rather than
      // silently emit a smaller ceiling, refuse: the dispatcher asked to
      // delegate authority that is no longer intact, and pretending otherwise
      // would hide the retirement from the audit trail.
      throw new AuthorizationSnapshotError(
        "parent_expired",
        `Parent snapshot ${parentRow.publicId} passed its validity boundary at ` +
          `${parentRow.nextValidityBoundaryAt.toISOString()} — re-admit rather than derive a child.`,
      );
    }

    const live =
      args.liveState ??
      (await readLiveAuthority(tx, {
        orgId: parentRow.orgId,
        workspaceId: parentRow.workspaceId,
        principalIds: [parent.initiatingPrincipalId, parent.agentPrincipalId],
      }));

    assertPrincipalsActive(live, [
      parent.initiatingPrincipalId,
      parent.agentPrincipalId,
    ]);

    // (1) still-valid parent bindings ∩ (2) current live rows, matched by id.
    const liveAssignmentIds = new Set(
      live.assignments
        .filter((a) => a.expiresAt === null || a.expiresAt.getTime() > nowMs)
        .map((a) => a.assignmentId),
    );
    const assignments = parent.assignments.filter((a) => {
      if (a.expiresAt !== null) {
        const at = Date.parse(a.expiresAt);
        if (!Number.isFinite(at) || at <= nowMs) return false;
      }
      return liveAssignmentIds.has(a.assignmentId);
    });

    const heldRoleIds = new Set(assignments.map((a) => a.roleId));
    const liveGrantById = new Map(live.roleGrants.map((g) => [g.grantId, g]));

    const allowlist = args.narrowingPolicy.capabilityAllowlist;
    const allowed = allowlist === undefined ? null : new Set<string>(allowlist);

    // Parent grants, narrowed by their live counterpart. A parent grant whose
    // live row is gone is dropped entirely (revocation narrows).
    const narrowedParentGrants: PinnedRoleGrant[] = [];
    for (const grant of parent.roleGrants) {
      if (!heldRoleIds.has(grant.roleId)) continue;
      if (allowed !== null && !allowed.has(grant.capabilityId)) continue;
      const liveGrant = liveGrantById.get(grant.grantId);
      if (liveGrant === undefined) continue;
      narrowedParentGrants.push({
        ...grant,
        effect: narrowerEffect(grant.effect, liveGrant.effect),
      });
    }

    // Live DENY grants on roles the child still holds. Additive ONLY because a
    // deny can never widen — this is the "live denies narrow an admitted
    // ceiling" rule expressed in the ceiling itself, not just at check time.
    const pinnedGrantIds = new Set(narrowedParentGrants.map((g) => g.grantId));
    const liveDenies: PinnedRoleGrant[] = live.roleGrants
      .filter(
        (g) =>
          g.effect === "deny" &&
          heldRoleIds.has(g.roleId) &&
          !pinnedGrantIds.has(g.grantId),
      )
      .map((g) => ({
        grantId: g.grantId,
        roleId: g.roleId,
        capabilityId: g.capabilityId,
        effect: "deny" as const,
        conditions: g.conditions,
      }));

    const roles = parent.roles.filter((r) => heldRoleIds.has(r.roleId));

    // (3) child narrowing. The child's expiry can only pull the boundary in.
    const parentBoundaryIso =
      parentRow.nextValidityBoundaryAt === null
        ? null
        : toIso(parentRow.nextValidityBoundaryAt);
    const narrowing: ChildRunNarrowingPolicy = {
      ...(allowlist === undefined
        ? {}
        : { capabilityAllowlist: [...allowlist] }),
      expiresAt: earlierIso(
        args.narrowingPolicy.expiresAt ?? null,
        parentBoundaryIso,
      ),
    };

    const ceiling: AuthorizationGrantCeiling = {
      version: 1,
      initiatingPrincipalId: parent.initiatingPrincipalId,
      agentPrincipalId: parent.agentPrincipalId,
      roles,
      assignments,
      roleGrants: [...narrowedParentGrants, ...liveDenies],
      parentSnapshotId: parentRow.publicId,
      narrowing,
    };

    const boundary = nextValidityBoundary(ceiling, now);
    const { grantCeilingDigest, snapshotDigest } = digestSnapshot({
      ceiling,
      orgId: parentRow.orgId,
      workspaceId: parentRow.workspaceId,
      denyGeneration: live.denyGeneration,
      nextValidityBoundaryAt: boundary,
      resolvedAt: toIso(now),
    });

    return insertSnapshot(tx, {
      orgId: parentRow.orgId,
      workspaceId: parentRow.workspaceId,
      ceiling,
      grantCeilingDigest,
      snapshotDigest,
      denyGeneration: live.denyGeneration,
      nextValidityBoundaryAt: boundary,
      resolvedAt: now,
    });
  });
}

/** The earlier of two RFC 3339 instants, treating null as "no bound". */
function earlierIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Reading a stored ceiling back
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asEffect(value: unknown): CapabilityEffect {
  return value === "allow" || value === "require_approval" ? value : "deny";
}

/**
 * Parse the canonical (snake_case) ceiling stored in `grant_ceiling` back into
 * the camelCase domain shape.
 *
 * Defensive rather than schema-validating on purpose: this row is written only
 * by `insertSnapshot` above, and a malformed field must degrade to the NARROWER
 * reading — an unparseable effect becomes `deny`, a missing id becomes the
 * empty string (which matches no principal), so corruption fails closed instead
 * of throwing mid-run and taking out an otherwise valid attempt.
 */
export function parseStoredCeiling(stored: unknown): AuthorizationGrantCeiling {
  const raw = asRecord(stored);
  const narrowingRaw = raw["narrowing"];
  const narrowing =
    narrowingRaw === null || narrowingRaw === undefined
      ? null
      : (() => {
          const n = asRecord(narrowingRaw);
          const list = n["capability_allowlist"];
          return {
            ...(Array.isArray(list)
              ? {
                  capabilityAllowlist: list.filter(
                    (v): v is string => typeof v === "string",
                  ),
                }
              : {}),
            expiresAt: asNullableString(n["expires_at"]),
          } satisfies ChildRunNarrowingPolicy;
        })();

  return {
    version: 1,
    initiatingPrincipalId: asString(raw["initiating_principal_id"]),
    agentPrincipalId: asString(raw["agent_principal_id"]),
    roles: (Array.isArray(raw["roles"]) ? raw["roles"] : []).map((entry) => {
      const r = asRecord(entry);
      return {
        roleId: asString(r["role_id"]),
        name: asString(r["name"]),
        scopeKind: r["scope_kind"] === "org" ? "org" : "workspace",
        isSystemDefault: r["is_system_default"] === true,
      } satisfies PinnedRole;
    }),
    assignments: (Array.isArray(raw["assignments"])
      ? raw["assignments"]
      : []
    ).map((entry) => {
      const a = asRecord(entry);
      return {
        assignmentId: asString(a["assignment_id"]),
        principalId: asString(a["principal_id"]),
        roleId: asString(a["role_id"]),
        workspaceId: asNullableString(a["workspace_id"]),
        assignedAt: asString(a["assigned_at"]),
        expiresAt: asNullableString(a["expires_at"]),
      } satisfies PinnedRoleAssignment;
    }),
    roleGrants: (Array.isArray(raw["role_grants"])
      ? raw["role_grants"]
      : []
    ).map((entry) => {
      const g = asRecord(entry);
      return {
        grantId: asString(g["grant_id"]),
        roleId: asString(g["role_id"]),
        capabilityId: asString(g["capability_id"]),
        effect: asEffect(g["effect"]),
        conditions: g["conditions"] ?? null,
      } satisfies PinnedRoleGrant;
    }),
    parentSnapshotId: asNullableString(raw["parent_snapshot_id"]),
    narrowing,
  };
}

/**
 * Load a persisted snapshot as the immutable binding a run context carries.
 * Used by the worker when hydrating a claimed run: the ceiling is read back
 * from the row, never rebuilt from current grants.
 */
export async function loadAuthorizationSnapshot(
  snapshotId: string,
): Promise<AgentRunAuthorizationBinding | null> {
  return withRepeatableReadTenantDb(async (tx) => {
    const isPublicId = snapshotId.startsWith("ras_");
    const [row] = await tx
      .select()
      .from(schema.authorizationSnapshots)
      .where(
        isPublicId
          ? eq(schema.authorizationSnapshots.publicId, snapshotId)
          : eq(schema.authorizationSnapshots.id, snapshotId),
      )
      .limit(1);
    if (row === undefined) return null;
    return {
      snapshotId: row.id,
      snapshotPublicId: row.publicId,
      snapshotDigest: row.snapshotDigest,
      grantCeilingDigest: row.grantCeilingDigest,
      ceiling: parseStoredCeiling(row.grantCeiling),
      denyGenerationAtAdmission: {
        org: Number(row.orgDenyGeneration),
        workspace: Number(row.workspaceDenyGeneration),
      },
      nextValidityBoundaryAt:
        row.nextValidityBoundaryAt === null
          ? null
          : toIso(row.nextValidityBoundaryAt),
      resolvedAt: toIso(row.resolvedAt),
    };
  });
}
