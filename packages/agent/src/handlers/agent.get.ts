// get_agent — one identity with its credentials, roles, hosts and the
// definition of record. Field semantics are on the contract
// (packages/oxagen/src/contracts/agent.get.ts).
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { AGENT_CREDENTIAL_SCOPE_PURPOSE } from "@oxagen/oxagen/agent-credential";
import { isManagedAgentType } from "@oxagen/oxagen/interactive-agent";
import type {
  AgentGetInput,
  AgentGetOutput,
} from "@oxagen/oxagen/contracts/agent.get";
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import {
  activeCredentialsByAgent,
  agentKeysFor,
  identityStatus,
  liveHostsByAgentKey,
  resolveAgentIdentity,
  runFiguresByAgent,
} from "./_agent-identity";

export type { AgentGetInput, AgentGetOutput };

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Every credential the agent has held, live first; revoked ones stay listed with their date. */
async function credentialsFor(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentPublicId: string,
): Promise<AgentGetOutput["credentials"]> {
  const rows = await tx
    .select({
      publicId: schema.apiKeys.publicId,
      name: schema.apiKeys.name,
      keyPrefix: schema.apiKeys.keyPrefix,
      createdAt: schema.apiKeys.createdAt,
      expiresAt: schema.apiKeys.expiresAt,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      deletedAt: schema.apiKeys.deletedAt,
    })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.orgId, scope.orgId),
        eq(schema.apiKeys.workspaceId, scope.workspaceId),
        sql`${schema.apiKeys.scope}->>'purpose' = ${AGENT_CREDENTIAL_SCOPE_PURPOSE}`,
        sql`${schema.apiKeys.scope}->>'agent_id' = ${agentPublicId}`,
      ),
    )
    .orderBy(
      sql`${schema.apiKeys.deletedAt} is not null`,
      desc(schema.apiKeys.createdAt),
    );
  return rows.map((r) => ({
    id: r.publicId,
    name: r.name,
    prefix: r.keyPrefix,
    createdAt: r.createdAt.toISOString(),
    expiresAt: iso(r.expiresAt),
    lastUsedAt: iso(r.lastUsedAt),
    revokedAt: iso(r.deletedAt),
  }));
}

/** The live role assignments on the agent's principal. */
async function rolesFor(
  tx: Tx,
  scope: { orgId: string },
  principalId: string,
): Promise<AgentGetOutput["roles"]> {
  const pra = schema.principalRoleAssignments;
  const rows = await tx
    .select({
      publicId: schema.roles.publicId,
      name: schema.roles.name,
      scopeKind: schema.roles.scopeKind,
      isSystemDefault: schema.roles.isSystemDefault,
      assignedAt: pra.assignedAt,
      expiresAt: pra.expiresAt,
    })
    .from(pra)
    .innerJoin(schema.roles, eq(schema.roles.id, pra.roleId))
    .where(
      and(
        eq(pra.principalId, principalId),
        eq(pra.orgId, scope.orgId),
        isNull(pra.deletedAt),
        or(isNull(pra.expiresAt), gt(pra.expiresAt, sql`now()`)),
      ),
    )
    .orderBy(schema.roles.name);
  return rows.map((r) => ({
    id: r.publicId,
    name: r.name,
    scopeKind: r.scopeKind as "org" | "workspace",
    isSystemDefault: r.isSystemDefault,
    assignedAt: r.assignedAt.toISOString(),
    expiresAt: iso(r.expiresAt),
  }));
}

/** Every host enrolled under the agent's key, live first. */
async function hostsFor(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
  agentKey: string,
): Promise<AgentGetOutput["hosts"]> {
  const h = schema.tachoHosts;
  const rows = await tx
    .select({
      publicId: h.publicId,
      hostname: h.hostname,
      platform: h.platform,
      status: h.status,
      mode: h.mode,
      harnesses: h.harnesses,
      deviceKeyFingerprint: h.deviceKeyFingerprint,
      wrapperVersion: h.wrapperVersion,
      hooksOk: h.hooksOk,
      bundleVersionServed: h.bundleVersionServed,
      lastSeenAt: h.lastSeenAt,
      expiresAt: h.expiresAt,
      revokedAt: h.revokedAt,
    })
    .from(h)
    .where(
      and(
        eq(h.orgId, scope.orgId),
        eq(h.workspaceId, scope.workspaceId),
        eq(h.agentKey, agentKey),
      ),
    )
    .orderBy(desc(h.createdAt));
  return rows.map((r) => ({
    hostEnrollmentId: r.publicId,
    hostname: r.hostname,
    platform: r.platform as AgentGetOutput["hosts"][number]["platform"],
    status: r.status as AgentGetOutput["hosts"][number]["status"],
    mode: r.mode as AgentGetOutput["hosts"][number]["mode"],
    harnesses: Array.isArray(r.harnesses) ? (r.harnesses as string[]) : [],
    deviceKeyFingerprint: r.deviceKeyFingerprint,
    collectorVersion: r.wrapperVersion,
    hooksOk: r.hooksOk,
    bundleVersionServed: r.bundleVersionServed,
    lastSeenAt: iso(r.lastSeenAt),
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: iso(r.revokedAt),
  }));
}

/** The latest version row that cached a commit, or null. */
async function definitionFor(
  tx: Tx,
  agentId: string,
): Promise<AgentGetOutput["definition"]> {
  const v = schema.agentVersions;
  const [row] = await tx
    .select({
      version: v.version,
      path: v.definitionPath,
      digest: v.definitionDigest,
      source: v.definitionSource,
      commitSha: v.commitSha,
      branch: v.branch,
      pullRequestUrl: v.pullRequestUrl,
      createdAt: v.createdAt,
    })
    .from(v)
    .where(and(eq(v.agentId, agentId), isNotNull(v.commitSha)))
    .orderBy(desc(v.version))
    .limit(1);
  if (
    !row ||
    row.path === null ||
    row.digest === null ||
    row.source === null ||
    row.commitSha === null ||
    row.branch === null ||
    row.pullRequestUrl === null
  )
    return null;
  return {
    version: row.version,
    path: row.path,
    digest: row.digest,
    commitSha: row.commitSha,
    branch: row.branch,
    pullRequestUrl: row.pullRequestUrl,
    source: row.source,
    committedAt: row.createdAt.toISOString(),
  };
}

export async function agentGetHandler(
  input: AgentGetInput,
  ctx: CapabilityContext,
): Promise<AgentGetOutput> {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  return withTenantDb(async (tx) => {
    const row = await resolveAgentIdentity(tx, input.agentId, scope);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "agent_not_found",
        message: `No agent "${input.agentId}" in this workspace`,
      });
    }
    const agentKey = (await agentKeysFor(tx, scope, [row])).get(row.id) ?? null;
    const credentials = await credentialsFor(tx, scope, row.publicId);
    const roles = row.principalId
      ? await rolesFor(tx, scope, row.principalId)
      : [];
    const hosts = agentKey ? await hostsFor(tx, scope, agentKey) : [];
    const definition = await definitionFor(tx, row.id);
    const figures = (
      await runFiguresByAgent(
        tx,
        scope,
        [{ id: row.id, agentKey }],
        new Date(0),
      )
    ).get(row.id);
    const held = {
      credentials:
        (await activeCredentialsByAgent(tx, scope, [row.publicId])).get(
          row.publicId,
        ) ?? 0,
      hosts: agentKey
        ? ((await liveHostsByAgentKey(tx, scope, [agentKey])).get(agentKey) ??
          0)
        : 0,
    };
    return {
      identity: {
        id: row.publicId,
        slug: row.slug,
        name: row.name,
        description: row.description,
        agentKey,
        harness: row.harness as AgentGetOutput["identity"]["harness"],
        managed: isManagedAgentType(row.agentType),
        principalId: row.principalPublicId,
        operatorId: row.operatorPublicId,
        status: identityStatus(row, held),
        registeredAt: row.createdAt.toISOString(),
        firstFrameAt: iso(figures?.earliestStartedAt ?? null),
        costCenter: row.costCenter,
      },
      credentials,
      roles,
      hosts,
      definition,
    };
  });
}
