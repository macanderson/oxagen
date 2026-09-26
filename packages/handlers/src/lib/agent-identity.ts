// agent-identity.ts — the shared plumbing of the agent identity writes
// (`register_agent`, `rotate_agent_credential`, `suspend_agent`,
// `retire_agent`; MC spec §6.2, #2956): resolving the identity row in the
// caller's workspace, minting the long-lived credential, and revoking it.
//
// A credential is an `auth.api_keys` row whose scope carries the
// server-owned purpose `agent_credential_v1` bound to the agent and its
// principal (@oxagen/oxagen/agent-credential). `generateApiKey` is the one
// minting routine (api-key-authz.ts), so the prefix window `@oxagen/auth`
// resolves keys by is the same for an agent credential as for any key.
import { schema, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import {
  AGENT_CREDENTIAL_SCOPE_PURPOSE,
  type AgentCredentialScope,
} from "@oxagen/oxagen/agent-credential";
import {
  isManagedAgentType,
  MANAGED_AGENT_READONLY_CODE,
} from "@oxagen/oxagen/interactive-agent";
import {
  resolveAgentIdentity,
  type AgentIdentityRow,
} from "@oxagen/agent/handlers/_agent-identity";
import { lockMandate, releaseParked } from "@oxagen/rules";
import { and, eq, isNull, sql } from "drizzle-orm";
import { generateApiKey } from "./api-key-authz";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The identity row, or `not_found`. Archived agents resolve; callers decide what a retired identity may do. */
export async function requireAgentIdentity(
  tx: Tx,
  identifier: string,
  scope: { orgId: string; workspaceId: string },
): Promise<AgentIdentityRow> {
  const row = await resolveAgentIdentity(tx, identifier, scope);
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "agent_not_found",
      message: `No agent "${identifier}" in this workspace`,
    });
  }
  return row;
}

/** A retired identity accepts no further identity write, and no new host. */
export function assertNotRetired(
  row: Pick<AgentIdentityRow, "slug" | "status">,
): void {
  if (row.status === "archived") {
    throw new HandlerError({
      code: "conflict",
      reason: "agent_retired",
      message: `Agent "${row.slug}" is retired`,
    });
  }
}

/**
 * The workspace's built-in assistant (`qa-chat`) is Oxagen's, and stella acts
 * as it on every turn. Retiring or suspending it suspends the
 * `oxagen.assistant` principal, which the run ceiling then refuses, so stella
 * stops answering in the workspace (#4350). A credential or a host for it
 * would let something outside Oxagen act as that principal. So every identity
 * write refuses it, the way the definition writes refuse it through
 * `assertAgentMutable`. The kill switch on the agent is the way to stop
 * stella, and the assistant turn honors it.
 */
export function assertNotManaged(
  row: Pick<AgentIdentityRow, "slug" | "agentType">,
): void {
  if (isManagedAgentType(row.agentType)) {
    throw new HandlerError({
      code: "forbidden",
      reason: MANAGED_AGENT_READONLY_CODE,
      message: `Agent "${row.slug}" is managed by Oxagen and cannot be changed. Use the kill switch to stop it.`,
    });
  }
}

interface MintedCredential {
  id: string;
  publicId: string;
  secret: string;
  expiresAt: Date;
}

/** Insert one agent credential; the secret is returned here and never again. */
export async function mintAgentCredential(
  tx: Tx,
  args: {
    orgId: string;
    workspaceId: string;
    userId: string;
    agent: Pick<AgentIdentityRow, "publicId" | "slug" | "principalPublicId">;
    validityDays: number;
    now: Date;
  },
): Promise<MintedCredential> {
  if (!args.agent.principalPublicId) {
    throw new HandlerError({
      code: "conflict",
      reason: "agent_principal_missing",
      message: `Agent "${args.agent.slug}" has no delegated principal`,
    });
  }
  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  const expiresAt = new Date(args.now.getTime() + args.validityDays * DAY_MS);
  const scope: AgentCredentialScope = {
    purpose: AGENT_CREDENTIAL_SCOPE_PURPOSE,
    agent_id: args.agent.publicId,
    principal_id: args.agent.principalPublicId,
  };
  const [key] = await tx
    .insert(schema.apiKeys)
    .values({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      keyPrefix,
      keyHash,
      name: `agent credential ${args.agent.slug}`,
      scope,
      expiresAt,
      createdById: args.userId,
      updatedById: args.userId,
    })
    .returning({ id: schema.apiKeys.id, publicId: schema.apiKeys.publicId });
  if (!key) throw new Error("api_keys insert returned no row");
  return { id: key.id, publicId: key.publicId, secret: rawKey, expiresAt };
}

/**
 * Revoke every active or draft mandate bound to the agent's principal, the
 * same way `retire_agent` revokes credentials and host enrollments rather
 * than refusing while one exists (ADR-106, #3124): a retired identity's
 * principal is suspended, so an authority it still held would read active
 * and in effect in the ledger but could never be used. Each mandate is
 * taken under its row lock, parked calls release their reservations the
 * way `revoke_mandate` does, and open approval requests expire — retiring
 * an agent ends its in-flight calls the same way revoking one mandate does.
 * Returns the public ids of the mandates revoked.
 */
export async function revokeAgentMandates(
  tx: Tx,
  args: {
    orgId: string;
    workspaceId: string;
    principalId: string;
    userId: string;
    reason: string;
    now: Date;
  },
): Promise<string[]> {
  const live = await tx
    .select({ id: schema.mandates.id })
    .from(schema.mandates)
    .where(
      and(
        eq(schema.mandates.orgId, args.orgId),
        eq(schema.mandates.workspaceId, args.workspaceId),
        eq(schema.mandates.agentPrincipalId, args.principalId),
        sql`${schema.mandates.status} IN ('active', 'draft')`,
      ),
    );
  const revoked: string[] = [];
  for (const { id } of live) {
    const locked = await lockMandate(tx, id);
    // Re-read under the lock: between the select above and this lock a
    // concurrent writer may have ended the mandate, or `grant_mandate` may
    // have activated the draft for a different agent. A row that is no
    // longer live, or no longer bound to the retiring principal, is not this
    // retirement's to revoke.
    if (
      !locked ||
      locked.agentPrincipalId !== args.principalId ||
      (locked.status !== "active" && locked.status !== "draft")
    )
      continue;
    await releaseParked(tx, locked);
    await tx
      .update(schema.approvalRequests)
      .set({ resolution: "expired", resolvedAt: args.now })
      .where(
        and(
          eq(schema.approvalRequests.mandateId, locked.id),
          isNull(schema.approvalRequests.resolution),
        ),
      );
    const [row] = await tx
      .update(schema.mandates)
      .set({
        status: "revoked",
        revokedBy: args.userId,
        revokedReason: args.reason,
        revokedAt: args.now,
        updatedAt: args.now,
        updatedById: args.userId,
      })
      .where(eq(schema.mandates.id, locked.id))
      .returning({ publicId: schema.mandates.publicId });
    if (row) revoked.push(row.publicId);
  }
  return revoked;
}

/** Soft-delete every live credential of the agent; returns their public ids. */
export async function revokeAgentCredentials(
  tx: Tx,
  args: {
    orgId: string;
    workspaceId: string;
    userId: string;
    agentPublicId: string;
    now: Date;
  },
): Promise<string[]> {
  const rows = await tx
    .update(schema.apiKeys)
    .set({
      deletedAt: args.now,
      deletedById: args.userId,
      updatedAt: args.now,
      updatedById: args.userId,
    })
    .where(
      and(
        eq(schema.apiKeys.orgId, args.orgId),
        eq(schema.apiKeys.workspaceId, args.workspaceId),
        sql`${schema.apiKeys.scope}->>'purpose' = ${AGENT_CREDENTIAL_SCOPE_PURPOSE}`,
        sql`${schema.apiKeys.scope}->>'agent_id' = ${args.agentPublicId}`,
        isNull(schema.apiKeys.deletedAt),
      ),
    )
    .returning({ publicId: schema.apiKeys.publicId });
  return rows.map((r) => r.publicId);
}
