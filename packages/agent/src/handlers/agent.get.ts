// get_agent — one agent with its credentials, roles, hosts, the runtime and
// toolbelt it is bound to, and its versions (ADR-192). Field semantics are on
// the contract (packages/oxagen/src/contracts/agent.get.ts).
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { AGENT_CREDENTIAL_SCOPE_PURPOSE } from "@oxagen/oxagen/agent-credential";
import {
  agentVersionBudget,
  agentVersionContainment,
} from "@oxagen/oxagen/agent-version-config";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { isManagedAgentType } from "@oxagen/oxagen/interactive-agent";
import type {
  AgentGetInput,
  AgentGetOutput,
} from "@oxagen/oxagen/contracts/agent.get";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import {
  activeCredentialsByAgent,
  agentKeysFor,
  bindingRefs,
  identityStatus,
  liveHostsByAgentKey,
  resolveAgentIdentity,
  runFiguresByAgent,
  runtimeRef,
  toolbeltRef,
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

/** The most versions one read returns (`agentGet.output.versions`). */
const VERSIONS_READ_LIMIT = 100;

/** The agent's version rows, newest first. */
async function versionRowsFor(
  tx: Tx,
  agentId: string,
): Promise<
  {
    version: number;
    changeKind: string;
    runtimeId: string | null;
    toolbeltId: string | null;
    createdById: string;
    createdAt: Date;
  }[]
> {
  const v = schema.agentVersions;
  return tx
    .select({
      version: v.version,
      changeKind: v.changeKind,
      runtimeId: v.runtimeId,
      toolbeltId: v.toolbeltId,
      createdById: v.createdById,
      createdAt: v.createdAt,
    })
    .from(v)
    .where(eq(v.agentId, agentId))
    .orderBy(desc(v.version))
    .limit(VERSIONS_READ_LIMIT);
}

/** `usr_…` of each user id, for the version writers. */
async function userPublicIds(
  tx: Tx,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.users.id, publicId: schema.users.publicId })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(rows.map((r) => [r.id, r.publicId]));
}

const NO_LIMITS: AgentGetOutput["limits"] = {
  perRun: null,
  perDay: null,
  containmentRequired: false,
  invalid: false,
};

/** Integer micros in the one currency the budget is stored in. */
function usd(micros: number | undefined): AgentGetOutput["limits"]["perRun"] {
  return micros === undefined
    ? null
    : { micros: String(micros), currency: "USD" };
}

/**
 * The limits the active version's config sets (ADR-192), read by the same
 * functions the host bundle reads them with (`resolveHostMandate`), so the
 * agent page shows the ceilings the host enforces. A config those functions
 * refuse is reported as invalid, the state in which the host suspends
 * governed actions.
 */
async function limitsFor(
  tx: Tx,
  agentId: string,
): Promise<AgentGetOutput["limits"]> {
  const [active] = await tx
    .select({ config: schema.agentVersions.config })
    .from(schema.agents)
    .innerJoin(
      schema.agentVersions,
      eq(schema.agentVersions.id, schema.agents.activeVersionId),
    )
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  if (!active) return NO_LIMITS;
  try {
    const budget = agentVersionBudget(active.config);
    const containment = agentVersionContainment(active.config);
    return {
      perRun: usd(budget?.perRunMicros),
      perDay: usd(budget?.perDayMicros),
      containmentRequired: containment?.required === true,
      invalid: false,
    };
  } catch (error) {
    if (isHandlerError(error) && error.reason === "invalid_agent_config")
      return { ...NO_LIMITS, invalid: true };
    throw error;
  }
}

const CHANGE_KINDS = new Set<AgentGetOutput["versions"][number]["changeKind"]>([
  "registered",
  "runtime_changed",
  "toolbelt_changed",
  "legacy",
]);

function changeKindOf(
  stored: string,
): AgentGetOutput["versions"][number]["changeKind"] {
  return CHANGE_KINDS.has(
    stored as AgentGetOutput["versions"][number]["changeKind"],
  )
    ? (stored as AgentGetOutput["versions"][number]["changeKind"])
    : "legacy";
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
    const versionRows = await versionRowsFor(tx, row.id);
    const bindings = await bindingRefs(tx, scope, {
      runtimeIds: [row.runtimeId, ...versionRows.map((v) => v.runtimeId)],
      toolbeltIds: [row.toolbeltId, ...versionRows.map((v) => v.toolbeltId)],
    });
    const writers = await userPublicIds(
      tx,
      versionRows.map((v) => v.createdById),
    );
    // A legacy version recorded no binding, so it names none rather than
    // borrowing the agent's current one.
    const versions = versionRows.map((v) => ({
      version: v.version,
      changeKind: changeKindOf(v.changeKind),
      runtime:
        v.runtimeId === null
          ? null
          : runtimeRef(bindings.runtimes.get(v.runtimeId)),
      toolbelt:
        v.toolbeltId === null
          ? null
          : toolbeltRef(bindings.toolbelts.get(v.toolbeltId)),
      createdBy: writers.get(v.createdById) ?? null,
      createdAt: v.createdAt.toISOString(),
    }));
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
      runtime:
        row.runtimeId === null
          ? null
          : runtimeRef(bindings.runtimes.get(row.runtimeId)),
      toolbelt: toolbeltRef(
        row.toolbeltId === null
          ? bindings.allTools
          : bindings.toolbelts.get(row.toolbeltId),
      ),
      versions,
      limits: await limitsFor(tx, row.id),
      credentials,
      roles,
      hosts,
    };
  });
}
