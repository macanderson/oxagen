/**
 * Removing a person from an organization, in one place (#3734, #3740).
 *
 * Four paths take a person's access away, and before this module each did a
 * different subset of the work:
 *
 *   - `remove_org_member`, an Owner or Admin removing someone by hand;
 *   - an SSO sign-in that no mapped group admits (ADR-145), which removed the
 *     org-wide role and the membership and left workspace roles, workspace
 *     membership and every API key in place (#3740 item 2);
 *   - a SCIM deprovision (`active: false` or `DELETE /Users/{id}`), which also
 *     has to end the person's browser sessions;
 *   - a SCIM group change that leaves the person in no mapped group, which is
 *     the SCIM form of the SSO deny.
 *
 * `removeOrgMemberInTx` is the one transaction body all four run. It takes a
 * caller's transaction so the removal and its audit rows commit or roll back
 * together, and it writes those audit rows with `emitSecurityEventIn` inside
 * the same transaction: a removal that committed always has its record, and a
 * removal that rolled back has none.
 *
 * `applyMappedOrgRoleInTx` is the role write an SSO sign-in and a SCIM group
 * change share. It replaces the person's org-wide role with the one the
 * mapping chose, and hands a `null` role to the removal above.
 *
 * tenancy: every statement pins `org_id` (or, for workspace membership, joins
 * to this organization's workspaces). Callers pass a `withSystemDb`
 * transaction, because three of the tables are workspace-scoped under RLS and
 * the removal has to reach every workspace (see org.member.remove.ts for the
 * failure that taught this).
 */
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  SSO_IAM_ROLE_NAME,
  type SsoMappableRole,
} from "@oxagen/oxagen/contracts/org.sso.shared";
import { CLI_SESSION_SCOPE_PURPOSE } from "@oxagen/oxagen/cli-session";
import type {
  MemberRemovalDetail,
  SecurityEventType,
} from "@oxagen/compliance";
import * as schema from "./schema";
import { emitSecurityEventIn } from "./security";
import type { Tx } from "./tenant";

// ── Tacho host revocation ────────────────────────────────────────────────────
// Moved here from packages/handlers/src/lib/tacho-host-revoke.ts, which now
// re-exports it, so a removal in @oxagen/auth can revoke a host without
// depending on @oxagen/handlers.

/** The scope purpose on a Tacho host's control-plane key. */
export const TACHO_HOST_SCOPE_PURPOSE = "tacho_host_v1" as const;

/**
 * The scope purpose on the second key an enrollment mints: the one the local
 * MCP gateway serves a connected app's tools with (ADR-078).
 */
export const TACHO_GATEWAY_SCOPE_PURPOSE = "tacho_gateway_v1" as const;

const REVOKE_COMMAND_TTL_MS = 24 * 60 * 60 * 1000;

export interface RevocableHost {
  id: string;
  publicId: string;
  apiKeyId: string;
}

/**
 * Retire every live credential this enrollment minted, and answer how many.
 *
 * Enrollment mints TWO keys (ADR-078): the host's control-plane key, whose id
 * `tacho_hosts.api_key_id` carries, and the MCP gateway key, whose id is
 * carried nowhere. Both record `scope.host_enrollment_id` at mint, which is
 * the one thing every credential of a host has in common, so that predicate
 * retires the pair.
 *
 * BOTH halves of the predicate matter. `create_api_key` takes a free-form
 * scope and a host's enrollment id is public, so the enrollment id alone could
 * match an ordinary key. `purpose` is the half the server owns:
 * `api.key.create` refuses a caller-supplied reserved Tacho purpose, so only
 * enrollment mints one (discussion_r4036214055).
 *
 * The control-plane key is then retired by the id the host row records, which
 * covers a legacy key that carries neither marker. Idempotent: `deleted_at IS
 * NULL` means a second call matches nothing.
 */
export async function retireEnrollmentKeys(
  tx: Tx,
  host: RevocableHost,
  args: { orgId: string; userId: string | null; now: Date },
): Promise<number> {
  const retirement = {
    deletedAt: args.now,
    deletedById: args.userId,
    updatedAt: args.now,
    updatedById: args.userId,
  };
  const swept = await tx
    .update(schema.apiKeys)
    .set(retirement)
    .where(
      and(
        eq(schema.apiKeys.orgId, args.orgId),
        isNull(schema.apiKeys.deletedAt),
        sql`${schema.apiKeys.scope} ->> 'purpose' IN (${TACHO_HOST_SCOPE_PURPOSE}, ${TACHO_GATEWAY_SCOPE_PURPOSE})`,
        sql`${schema.apiKeys.scope} ->> 'host_enrollment_id' = ${host.publicId}`,
      ),
    )
    .returning({ id: schema.apiKeys.id });
  if (swept.some((k) => k.id === host.apiKeyId)) return swept.length;
  const byId = await tx
    .update(schema.apiKeys)
    .set(retirement)
    .where(
      and(
        eq(schema.apiKeys.id, host.apiKeyId),
        isNull(schema.apiKeys.deletedAt),
      ),
    )
    .returning({ id: schema.apiKeys.id });
  return swept.length + byId.length;
}

/**
 * The three writes that revoke a Tacho host: the row becomes `revoked`, every
 * key its enrollment minted is retired, and a `revoke` command is queued so a
 * collector mid-poll learns at once rather than at its next bundle refresh.
 * `revoke_tacho_enrollment`, `retire_agent` and the member removal below all
 * run it.
 */
export async function revokeHostEnrollment(
  tx: Tx,
  host: RevocableHost,
  args: {
    orgId: string;
    workspaceId: string;
    userId: string | null;
    /** Recorded on the host row (null when the operator gave none) and carried in the command. */
    reason: string | null;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(schema.tachoHosts)
    .set({
      status: "revoked",
      revokedAt: args.now,
      revokeReason: args.reason,
      updatedAt: args.now,
      updatedById: args.userId,
    })
    .where(eq(schema.tachoHosts.id, host.id));
  await retireEnrollmentKeys(tx, host, {
    orgId: args.orgId,
    userId: args.userId,
    now: args.now,
  });
  await tx.insert(schema.tachoControlCommands).values({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    hostId: host.id,
    targetKind: "host",
    targetId: host.publicId,
    command: "revoke",
    payload: { reason: args.reason ?? "revoked by operator" },
    reason: args.reason,
    issuedByUserId: args.userId,
    issuedAt: args.now,
    expiresAt: new Date(args.now.getTime() + REVOKE_COMMAND_TTL_MS),
    createdById: args.userId,
    updatedById: args.userId,
  });
}

// ── Member removal ───────────────────────────────────────────────────────────

export type MemberRemovalTrigger = MemberRemovalDetail["trigger"] | "manual";

/** Thrown when a removal that refuses Owners meets one. Nothing was written. */
export class OwnerRemovalRefused extends Error {
  readonly code = "owner_protected";
  constructor(readonly userId: string) {
    super(
      "This person is an Owner in Oxagen. An Owner leaves only by an ownership transfer inside Oxagen.",
    );
    this.name = "OwnerRemovalRefused";
  }
}

export interface RemoveOrgMemberOptions {
  orgId: string;
  /** The person being removed (auth.users.id). */
  userId: string;
  /** Recorded as the actor; null when the identity provider did it. */
  actorId: string | null;
  trigger: MemberRemovalTrigger;
  /**
   * Delete every `auth.sessions` row the person holds. A session belongs to
   * the user, not to one organization, so this signs them out everywhere.
   * Only a deprovision asks for it: the identity provider owns the identity,
   * and its removal ends the identity. A manual removal from one organization
   * and a deny sign-in leave the person's other organizations alone.
   */
  endSessions: boolean;
  /**
   * Which keys the person created in this organization are revoked. `all`
   * covers plain keys, CLI session keys and every machine purpose, and also
   * revokes each Tacho host they enrolled and expires each enrollment token
   * issued to them, so a cached enrollment cannot mint a replacement key.
   * `cli_sessions` is what a manual removal has always revoked.
   */
  keys: "all" | "cli_sessions";
  /** Refuse, before any write, when the person holds the Owner role here. */
  refuseOwner: boolean;
  /**
   * What happens to the person's human principal in this organization.
   * `deleted` is a manual removal. `suspended` is a SCIM deprovision, and it
   * is what keeps a later SSO sign-in from re-admitting the person until the
   * identity provider reactivates them. `keep` leaves it for a deny sign-in,
   * which a later mapped sign-in reverses.
   */
  principalStatus: "deleted" | "suspended" | "keep";
  /** A summary event written with the per-credential rows, or null for none. */
  summaryEvent: Extract<
    SecurityEventType,
    "scim.user_deprovisioned" | "org.member_removed"
  > | null;
  requestId?: string | null;
  now?: Date;
}

export interface MemberRemovalResult {
  userId: string;
  /** False when the person held nothing in this organization to remove. */
  wasMember: boolean;
  sessionIds: string[];
  apiKeyIds: string[];
  hostIds: string[];
  enrollmentTokensExpired: number;
  roleAssignmentsRevoked: number;
  workspaceMembershipsRemoved: number;
}

/** Whether `userId` holds the Owner org role here, by role string or IAM assignment. Locks the membership row. */
export async function isOrgOwner(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const [member] = await tx
    .select({ role: schema.orgUsers.role })
    .from(schema.orgUsers)
    .where(
      and(eq(schema.orgUsers.orgId, orgId), eq(schema.orgUsers.userId, userId)),
    )
    .limit(1)
    .for("update");
  if (member?.role.toLowerCase() === "owner") return true;
  const [assignment] = await tx
    .select({ id: schema.principalRoleAssignments.id })
    .from(schema.principalRoleAssignments)
    .innerJoin(
      schema.principals,
      eq(schema.principals.id, schema.principalRoleAssignments.principalId),
    )
    .innerJoin(
      schema.roles,
      eq(schema.roles.id, schema.principalRoleAssignments.roleId),
    )
    .where(
      and(
        eq(schema.principalRoleAssignments.orgId, orgId),
        eq(schema.principals.orgId, orgId),
        eq(schema.principals.parentUserId, userId),
        eq(schema.principals.kind, "human"),
        eq(schema.roles.name, "Owner"),
        eq(schema.roles.scopeKind, "org"),
        isNull(schema.principalRoleAssignments.workspaceId),
        isNull(schema.principalRoleAssignments.deletedAt),
      ),
    )
    .limit(1);
  return assignment !== undefined;
}

function purposeOf(scope: unknown): string | null {
  return typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    typeof scope.purpose === "string"
    ? scope.purpose
    : null;
}

/**
 * Take a person's access to one organization away, in the caller's
 * transaction. The steps, in order:
 *
 *   1. Refuse an Owner when asked to (a SCIM deprovision), before any write.
 *   2. Soft-delete every live role assignment of the person's human principal
 *      in this organization, org-wide and workspace-scoped alike, and set the
 *      principal's status.
 *   3. Delete the `org.org_users` row and every `workspace.workspace_users`
 *      row in this organization's workspaces.
 *   4. Revoke keys: every Tacho host the person enrolled through
 *      `revokeHostEnrollment`, every unused enrollment token issued to them
 *      (expired now), then every remaining key they created here.
 *   5. Delete every session the person holds, when asked to.
 *   6. Write one audit row per ended session (`auth.sign_out` and
 *      `security.session_revoked`), per revoked key (`api_key.revoked`) and
 *      per revoked host (`tacho.host_revoked`), then the summary event.
 *
 * Every step is idempotent, so a repeated deprovision writes nothing new.
 */
export async function removeOrgMemberInTx(
  tx: Tx,
  opts: RemoveOrgMemberOptions,
): Promise<MemberRemovalResult> {
  const { orgId, userId, actorId } = opts;
  const now = opts.now ?? new Date();

  if (opts.refuseOwner && (await isOrgOwner(tx, orgId, userId))) {
    throw new OwnerRemovalRefused(userId);
  }

  // ── 2. Roles and principal ────────────────────────────────────────────────
  const principals = await tx
    .select({ id: schema.principals.id })
    .from(schema.principals)
    .where(
      and(
        eq(schema.principals.orgId, orgId),
        eq(schema.principals.parentUserId, userId),
        eq(schema.principals.kind, "human"),
      ),
    );
  const principalIds = principals.map((p) => p.id);
  let roleAssignmentsRevoked = 0;
  if (principalIds.length > 0) {
    const revoked = await tx
      .update(schema.principalRoleAssignments)
      .set({
        deletedAt: now,
        deletedById: actorId,
        updatedAt: now,
        updatedById: actorId,
      })
      .where(
        and(
          eq(schema.principalRoleAssignments.orgId, orgId),
          inArray(schema.principalRoleAssignments.principalId, principalIds),
          isNull(schema.principalRoleAssignments.deletedAt),
        ),
      )
      .returning({ id: schema.principalRoleAssignments.id });
    roleAssignmentsRevoked = revoked.length;
    if (opts.principalStatus !== "keep") {
      await tx
        .update(schema.principals)
        .set({
          status: opts.principalStatus,
          updatedAt: now,
          updatedById: actorId,
          ...(opts.principalStatus === "suspended"
            ? {
                metadata: sql`${schema.principals.metadata} || ${JSON.stringify(
                  { scim_deprovisioned_at: now.toISOString() },
                )}::jsonb`,
              }
            : {}),
        })
        .where(inArray(schema.principals.id, principalIds));
    }
  }

  // ── 3. Membership ─────────────────────────────────────────────────────────
  const removedMembership = await tx
    .delete(schema.orgUsers)
    .where(
      and(eq(schema.orgUsers.orgId, orgId), eq(schema.orgUsers.userId, userId)),
    )
    .returning({ id: schema.orgUsers.id });
  // workspace.workspace_users carries no org_id: the org fence is the join to
  // this organization's workspaces.
  const orgWorkspaces = await tx
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.orgId, orgId));
  let workspaceMembershipsRemoved = 0;
  if (orgWorkspaces.length > 0) {
    const removed = await tx
      .delete(schema.workspaceUsers)
      .where(
        and(
          inArray(
            schema.workspaceUsers.workspaceId,
            orgWorkspaces.map((w) => w.id),
          ),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .returning({ id: schema.workspaceUsers.id });
    workspaceMembershipsRemoved = removed.length;
  }

  // ── 4. Keys ───────────────────────────────────────────────────────────────
  const hostIds: string[] = [];
  const revokedKeys: { id: string; purpose: string | null }[] = [];
  let enrollmentTokensExpired = 0;
  const reason =
    opts.trigger === "manual"
      ? "member removed"
      : `member removed (${opts.trigger})`;
  if (opts.keys === "all") {
    const hosts = await tx
      .select({
        id: schema.tachoHosts.id,
        publicId: schema.tachoHosts.publicId,
        apiKeyId: schema.tachoHosts.apiKeyId,
        workspaceId: schema.tachoHosts.workspaceId,
      })
      .from(schema.tachoHosts)
      .where(
        and(
          eq(schema.tachoHosts.orgId, orgId),
          eq(schema.tachoHosts.createdById, userId),
          ne(schema.tachoHosts.status, "revoked"),
        ),
      );
    if (hosts.length > 0) {
      // Read the keys the host revocations are about to retire, so each one
      // gets its own api_key.revoked row: revokeHostEnrollment retires them by
      // enrollment id or by the host's key id, and the creator sweep below
      // then no longer sees them.
      const hostKeys = await tx
        .select({ id: schema.apiKeys.id, scope: schema.apiKeys.scope })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.orgId, orgId),
            isNull(schema.apiKeys.deletedAt),
            or(
              inArray(
                schema.apiKeys.id,
                hosts.map((h) => h.apiKeyId),
              ),
              and(
                sql`${schema.apiKeys.scope} ->> 'purpose' IN (${TACHO_HOST_SCOPE_PURPOSE}, ${TACHO_GATEWAY_SCOPE_PURPOSE})`,
                inArray(
                  sql`${schema.apiKeys.scope} ->> 'host_enrollment_id'`,
                  hosts.map((h) => h.publicId),
                ),
              ),
            ),
          ),
        );
      revokedKeys.push(
        ...hostKeys.map((k) => ({ id: k.id, purpose: purposeOf(k.scope) })),
      );
    }
    for (const host of hosts) {
      await revokeHostEnrollment(tx, host, {
        orgId,
        workspaceId: host.workspaceId,
        userId: actorId,
        reason,
        now,
      });
      hostIds.push(host.publicId);
    }
    // An unused enrollment token would let the person enroll a new host, and
    // mint a new key in their name, after this removal.
    const expired = await tx
      .update(schema.tachoEnrollmentTokens)
      .set({ expiresAt: now })
      .where(
        and(
          eq(schema.tachoEnrollmentTokens.orgId, orgId),
          eq(schema.tachoEnrollmentTokens.issuedToUserId, userId),
          isNull(schema.tachoEnrollmentTokens.usedAt),
          gt(schema.tachoEnrollmentTokens.expiresAt, now),
        ),
      )
      .returning({ id: schema.tachoEnrollmentTokens.id });
    enrollmentTokensExpired = expired.length;
  }
  const keyRows = await tx
    .update(schema.apiKeys)
    .set({
      deletedAt: now,
      deletedById: actorId,
      updatedAt: now,
      updatedById: actorId,
    })
    .where(
      and(
        eq(schema.apiKeys.orgId, orgId),
        eq(schema.apiKeys.createdById, userId),
        isNull(schema.apiKeys.deletedAt),
        ...(opts.keys === "cli_sessions"
          ? [
              sql`${schema.apiKeys.scope}->>'purpose' = ${CLI_SESSION_SCOPE_PURPOSE}`,
            ]
          : []),
      ),
    )
    .returning({ id: schema.apiKeys.id, scope: schema.apiKeys.scope });
  for (const k of keyRows) {
    if (!revokedKeys.some((r) => r.id === k.id)) {
      revokedKeys.push({ id: k.id, purpose: purposeOf(k.scope) });
    }
  }
  // ── 5. Sessions ───────────────────────────────────────────────────────────
  let sessionIds: string[] = [];
  if (opts.endSessions) {
    const ended = await tx
      .delete(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .returning({ id: schema.sessions.id });
    sessionIds = ended.map((s) => s.id);
  }

  const result: MemberRemovalResult = {
    userId,
    wasMember:
      removedMembership.length > 0 ||
      roleAssignmentsRevoked > 0 ||
      workspaceMembershipsRemoved > 0,
    sessionIds,
    apiKeyIds: revokedKeys.map((k) => k.id),
    hostIds,
    enrollmentTokensExpired,
    roleAssignmentsRevoked,
    workspaceMembershipsRemoved,
  };

  // ── 6. Audit, in the same transaction ─────────────────────────────────────
  // A manual removal keeps the rows it always wrote (org.member_removed,
  // emitted by its handler) and adds a plain api_key.revoked per key; the
  // removal detail belongs to the identity-provider triggers.
  const trigger = opts.trigger === "manual" ? null : opts.trigger;
  const base = {
    actorUserId: actorId,
    orgId,
    workspaceId: null,
    capability: null,
    ip: null,
    userAgent: null,
    requestId: opts.requestId ?? null,
  } as const;
  const credential = (value: string) =>
    trigger === null
      ? undefined
      : {
          reason: "member_removed" as const,
          trigger,
          subjectUserId: userId,
          credential: value,
        };
  for (const sessionId of sessionIds) {
    for (const eventType of [
      "auth.sign_out",
      "security.session_revoked",
    ] as const) {
      await emitSecurityEventIn(tx, {
        ...base,
        eventType,
        outcome: "success",
        detail: credential(sessionId),
      });
    }
  }
  for (const key of revokedKeys) {
    await emitSecurityEventIn(tx, {
      ...base,
      eventType: "api_key.revoked",
      outcome: "success",
      detail: credential(key.purpose ?? "api_key"),
    });
  }
  for (const hostId of hostIds) {
    await emitSecurityEventIn(tx, {
      ...base,
      eventType: "tacho.host_revoked",
      outcome: "success",
      detail: credential(hostId),
    });
  }
  if (opts.summaryEvent !== null && trigger !== null) {
    const detail: MemberRemovalDetail = {
      userId,
      trigger,
      sessionsEnded: sessionIds.length,
      apiKeysRevoked: revokedKeys.length,
      hostsRevoked: hostIds.length,
      enrollmentTokensExpired,
      roleAssignmentsRevoked,
      workspaceMembershipsRemoved,
    };
    await emitSecurityEventIn(tx, {
      ...base,
      eventType: opts.summaryEvent,
      outcome: "success",
      detail,
    });
  }
  return result;
}

// ── Mapped role (SSO sign-in and SCIM groups) ────────────────────────────────

async function ensureMemberPrincipal(
  tx: Tx,
  orgId: string,
  userId: string,
  actorId: string | null,
): Promise<{ id: string; status: string; metadata: unknown }> {
  const select = () =>
    tx
      .select({
        id: schema.principals.id,
        status: schema.principals.status,
        metadata: schema.principals.metadata,
      })
      .from(schema.principals)
      .where(
        and(
          eq(schema.principals.orgId, orgId),
          eq(schema.principals.parentUserId, userId),
          eq(schema.principals.kind, "human"),
          isNull(schema.principals.workspaceId),
        ),
      )
      .limit(1);
  const [existing] = await select();
  if (existing) return existing;

  const [user] = await tx
    .select({
      displayName: schema.users.displayName,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  await tx
    .insert(schema.principals)
    .values({
      orgId,
      kind: "human",
      displayName: user?.displayName ?? user?.email ?? userId,
      status: "active",
      parentUserId: userId,
      createdById: actorId,
      updatedById: actorId,
    })
    .onConflictDoNothing();
  // Re-read: the insert either landed, or lost a race to a concurrent one.
  const [row] = await select();
  if (!row) {
    throw new Error(
      `Could not create a principal for user ${userId} in org ${orgId}`,
    );
  }
  return row;
}

/** Whether a SCIM deprovision suspended this principal. */
export function isScimSuspended(principal: {
  status: string;
  metadata: unknown;
}): boolean {
  return (
    principal.status === "suspended" &&
    typeof principal.metadata === "object" &&
    principal.metadata !== null &&
    "scim_deprovisioned_at" in principal.metadata
  );
}

async function grantOrgRole(
  tx: Tx,
  orgId: string,
  principalId: string,
  iamRoleName: string,
  actorId: string | null,
): Promise<void> {
  const [roleRow] = await tx
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.orgId, orgId),
        eq(schema.roles.scopeKind, "org"),
        eq(schema.roles.name, iamRoleName),
      ),
    )
    .limit(1);
  if (!roleRow) {
    throw new Error(`No '${iamRoleName}' org role in org ${orgId}`);
  }
  const now = new Date();
  // onConflictDoUpdate, never onConflictDoNothing: change_member_role's
  // comments record the outage a resurrect-by-nothing caused.
  await tx
    .insert(schema.principalRoleAssignments)
    .values({
      principalId,
      roleId: roleRow.id,
      orgId,
      assignedBy: actorId,
      createdById: actorId,
      updatedById: actorId,
    })
    .onConflictDoUpdate({
      target: [
        schema.principalRoleAssignments.principalId,
        schema.principalRoleAssignments.roleId,
        schema.principalRoleAssignments.orgId,
      ],
      targetWhere: isNull(schema.principalRoleAssignments.workspaceId),
      set: {
        deletedAt: null,
        deletedById: null,
        expiresAt: null,
        assignedBy: actorId,
        assignedAt: now,
        updatedAt: now,
        updatedById: actorId,
      },
    });
  const [granted] = await tx
    .select({ id: schema.principalRoleAssignments.id })
    .from(schema.principalRoleAssignments)
    .where(
      and(
        eq(schema.principalRoleAssignments.principalId, principalId),
        eq(schema.principalRoleAssignments.orgId, orgId),
        eq(schema.principalRoleAssignments.roleId, roleRow.id),
        isNull(schema.principalRoleAssignments.workspaceId),
        isNull(schema.principalRoleAssignments.deletedAt),
      ),
    )
    .limit(1);
  if (!granted) {
    throw new Error(
      `Granted '${iamRoleName}' in org ${orgId} but the assignment did not take`,
    );
  }
}

export type MappedRoleOutcome =
  | { kind: "owner_unmanaged" }
  | { kind: "scim_suspended" }
  | { kind: "granted"; role: SsoMappableRole }
  | { kind: "removed"; removal: MemberRemovalResult };

/**
 * Make `role` the person's organization role, or remove them when `role` is
 * null. An SSO sign-in and a SCIM group change both run this.
 *
 *   - An Owner is never changed: ownership passes by a transfer inside Oxagen.
 *   - A person a SCIM deprovision suspended is not re-admitted by a mapped
 *     group; only the identity provider reactivating them does that.
 *   - A mapped role soft-deletes the person's org-wide assignments and grants
 *     the new one, then upserts `org_users` with the role name.
 *   - No role is a removal: `removeOrgMemberInTx` with every key revoked and
 *     the sessions left alone, because a session is not this organization's
 *     to end. The removal writes its audit rows; `org.member_removed` carries
 *     the counts.
 */
export async function applyMappedOrgRoleInTx(
  tx: Tx,
  args: {
    orgId: string;
    userId: string;
    role: SsoMappableRole | null;
    /** The person signing in, or null for a SCIM change. */
    actorId: string | null;
    trigger: "sso_deny" | "scim_group_change";
    requestId?: string | null;
  },
): Promise<MappedRoleOutcome> {
  const { orgId, userId, role, actorId } = args;
  // Re-read inside the transaction, locked: a concurrent promotion to Owner
  // must win over this write. Owner by either record, the org_users role or
  // the IAM assignment, so the two cannot disagree their way past this.
  if (await isOrgOwner(tx, orgId, userId)) return { kind: "owner_unmanaged" };

  if (role === null) {
    const removal = await removeOrgMemberInTx(tx, {
      orgId,
      userId,
      actorId,
      trigger: args.trigger,
      endSessions: false,
      keys: "all",
      refuseOwner: false,
      principalStatus: "keep",
      summaryEvent: "org.member_removed",
      requestId: args.requestId ?? null,
    });
    return { kind: "removed", removal };
  }

  const principal = await ensureMemberPrincipal(tx, orgId, userId, actorId);
  if (isScimSuspended(principal)) return { kind: "scim_suspended" };

  const now = new Date();
  await tx
    .update(schema.principalRoleAssignments)
    .set({
      deletedAt: now,
      deletedById: actorId,
      updatedAt: now,
      updatedById: actorId,
    })
    .where(
      and(
        eq(schema.principalRoleAssignments.principalId, principal.id),
        eq(schema.principalRoleAssignments.orgId, orgId),
        isNull(schema.principalRoleAssignments.workspaceId),
        isNull(schema.principalRoleAssignments.deletedAt),
      ),
    );
  if (principal.status !== "active") {
    // A manual removal marked the principal deleted; a mapped group admits
    // the person again, as an invitation back would.
    await tx
      .update(schema.principals)
      .set({ status: "active", updatedAt: now, updatedById: actorId })
      .where(eq(schema.principals.id, principal.id));
  }
  const iamRoleName = SSO_IAM_ROLE_NAME[role];
  if (iamRoleName) {
    await grantOrgRole(tx, orgId, principal.id, iamRoleName, actorId);
  }
  await tx
    .insert(schema.orgUsers)
    .values({
      orgId,
      userId,
      role,
      joinedAt: now,
      createdById: actorId,
      updatedById: actorId,
    })
    .onConflictDoUpdate({
      target: [schema.orgUsers.orgId, schema.orgUsers.userId],
      set: { role, updatedAt: now, updatedById: actorId },
    });
  return { kind: "granted", role };
}
