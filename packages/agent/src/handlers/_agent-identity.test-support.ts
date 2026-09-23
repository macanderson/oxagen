// _agent-identity.test-support.ts — a seeded tenant for the agent identity
// handler tests (packages/agent and packages/handlers). Every writer inserts
// through the system connection into the real tables the handlers read, so a
// test proves the handler's predicates against Postgres rather than the shape
// of a canned reply (apps/app/ARCHITECTURE.md §6.1, Kernel row). Only runs
// where DATABASE_URL is set; the test files skip otherwise.
import { schema, withSystemDb } from "@oxagen/database";
import { AGENT_CREDENTIAL_SCOPE_PURPOSE } from "@oxagen/oxagen/agent-credential";
import type { CapabilityContext } from "@oxagen/oxagen";
import { inArray } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeededTenant {
  tag: string;
  orgId: string;
  workspaceId: string;
  orgNamespace: string;
  workspaceNamespace: string;
  /** The signed-in user the tests act as. */
  userId: string;
  userPublicId: string;
}

export interface SeededAgent {
  id: string;
  publicId: string;
  slug: string;
  principalId: string | null;
  principalPublicId: string | null;
  agentKey: string | null;
}

/** Six lowercase alphanumerics: a namespace the CHECK admits, unique enough per run. */
function namespace(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

export function ctxFor(
  tenant: Pick<SeededTenant, "orgId" | "workspaceId">,
  userId: string | null,
): CapabilityContext {
  return {
    orgId: tenant.orgId,
    workspaceId: tenant.workspaceId,
    userId,
    apiKeyId: userId ? null : "0192d4a8-7c1e-7a00-8000-00000000a0ee",
    requestId: "req_identity_test",
    surface: "api",
    messageId: null,
  };
}

/** An org, a workspace with namespaces, and one user. `planType` is the tier the org is on. */
export async function seedTenant(
  planType: "free" | "enterprise" = "free",
): Promise<SeededTenant> {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const orgNamespace = namespace();
  const workspaceNamespace = namespace();
  return withSystemDb(async (tx) => {
    const [org] = await tx
      .insert(schema.organizations)
      .values({
        name: `Identity ${tag}`,
        slug: `identity-${tag}`,
        planType,
        status: "active",
        namespace: orgNamespace,
      })
      .returning({ id: schema.organizations.id });
    const [ws] = await tx
      .insert(schema.workspaces)
      .values({
        orgId: org!.id,
        name: "core",
        slug: `core-${tag}`,
        namespace: workspaceNamespace,
      })
      .returning({ id: schema.workspaces.id });
    const [user] = await tx
      .insert(schema.users)
      .values({ email: `identity-${tag}@agents.test`, status: "active" })
      .returning({ id: schema.users.id, publicId: schema.users.publicId });
    return {
      tag,
      orgId: org!.id,
      workspaceId: ws!.id,
      orgNamespace,
      workspaceNamespace,
      userId: user!.id,
      userPublicId: user!.publicId,
    };
  });
}

/** Give the tenant's user a human principal holding one org-scoped role. */
export async function seedMember(
  tenant: SeededTenant,
  roleName: string,
  userId: string = tenant.userId,
): Promise<{ principalId: string }> {
  return withSystemDb(async (tx) => {
    const [principal] = await tx
      .insert(schema.principals)
      .values({
        orgId: tenant.orgId,
        kind: "human",
        displayName: roleName,
        parentUserId: userId,
        status: "active",
      })
      .returning({ id: schema.principals.id });
    const [role] = await tx
      .insert(schema.roles)
      .values({ orgId: tenant.orgId, scopeKind: "org", name: roleName })
      .returning({ id: schema.roles.id });
    await tx.insert(schema.principalRoleAssignments).values({
      principalId: principal!.id,
      roleId: role!.id,
      orgId: tenant.orgId,
      workspaceId: null,
      assignedBy: userId,
    });
    return { principalId: principal!.id };
  });
}

export async function seedAgent(
  tenant: SeededTenant,
  over: {
    slug: string;
    name?: string;
    harness?: string;
    status?: "draft" | "active" | "archived";
    /** null: no delegated principal (a row from before Agent RBAC). */
    principalStatus?: "active" | "suspended" | null;
    operatorUserId?: string | null;
    deletedAt?: Date | null;
    workspaceId?: string;
    /** A cost-center label as set_cost_center stores it (ADR-142). */
    costCenter?: string | null;
  },
): Promise<SeededAgent> {
  const workspaceId = over.workspaceId ?? tenant.workspaceId;
  // tenancy: test fixture seeding outside any request. Every row is scoped to
  // the seeded tenant's orgId and workspaceId, and cleanupTenants removes it.
  return withSystemDb(async (tx) => {
    let principal: { id: string; publicId: string } | null = null;
    if (over.principalStatus !== null) {
      const [row] = await tx
        .insert(schema.principals)
        .values({
          orgId: tenant.orgId,
          workspaceId,
          kind: "agent",
          displayName: over.name ?? over.slug,
          parentUserId:
            over.operatorUserId === undefined
              ? tenant.userId
              : over.operatorUserId,
          status: over.principalStatus ?? "active",
        })
        .returning({
          id: schema.principals.id,
          publicId: schema.principals.publicId,
        });
      principal = row!;
    }
    const [agent] = await tx
      .insert(schema.agents)
      .values({
        orgId: tenant.orgId,
        workspaceId,
        slug: over.slug,
        name: over.name ?? over.slug,
        agentType: "custom",
        harness: over.harness ?? "custom",
        status: over.status ?? "draft",
        deploymentStatus: "inactive",
        principalId: principal?.id ?? null,
        costCenter: over.costCenter ?? null,
        deletedAt: over.deletedAt ?? null,
        createdById: tenant.userId,
        updatedById: tenant.userId,
      })
      .returning({ id: schema.agents.id, publicId: schema.agents.publicId });
    return {
      id: agent!.id,
      publicId: agent!.publicId,
      slug: over.slug,
      principalId: principal?.id ?? null,
      principalPublicId: principal?.publicId ?? null,
      agentKey:
        workspaceId === tenant.workspaceId
          ? `${tenant.orgNamespace}.${tenant.workspaceNamespace}.${over.slug}`
          : null,
    };
  });
}

/** One long-lived agent credential; `expired` or `revoked` make it inactive. */
export async function seedCredential(
  tenant: SeededTenant,
  agent: SeededAgent,
  over: { expired?: boolean; revoked?: boolean; name?: string } = {},
): Promise<{ id: string; publicId: string }> {
  const now = Date.now();
  return withSystemDb(async (tx) => {
    const [row] = await tx
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
        keyPrefix: `ox_${agent.slug.slice(0, 6)}${Math.random().toString(36).slice(2, 6)}`,
        keyHash: `hash-${Math.random().toString(36).slice(2)}`,
        name: over.name ?? `agent credential ${agent.slug}`,
        scope: {
          purpose: AGENT_CREDENTIAL_SCOPE_PURPOSE,
          agent_id: agent.publicId,
          principal_id: agent.principalPublicId ?? "prn_none",
        },
        expiresAt: new Date(now + (over.expired ? -1 : 180) * DAY_MS),
        deletedAt: over.revoked ? new Date(now - DAY_MS) : null,
        createdById: tenant.userId,
        updatedById: tenant.userId,
      })
      .returning({ id: schema.apiKeys.id, publicId: schema.apiKeys.publicId });
    return row!;
  });
}

/** A host enrolled under `agentKey`, with the host API key it holds. */
export async function seedHost(
  tenant: SeededTenant,
  agentKey: string,
  over: {
    status?: "active" | "paused" | "suspended" | "revoked";
    hostname?: string;
  } = {},
): Promise<{ id: string; publicId: string; apiKeyId: string }> {
  const status = over.status ?? "active";
  const now = new Date();
  return withSystemDb(async (tx) => {
    const [key] = await tx
      .insert(schema.apiKeys)
      .values({
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
        keyPrefix: `ox_host${Math.random().toString(36).slice(2, 8)}`,
        keyHash: `hash-${Math.random().toString(36).slice(2)}`,
        name: `tacho host ${over.hostname ?? "build"}`,
        scope: { purpose: "tacho_host_v1" },
        createdById: tenant.userId,
        updatedById: tenant.userId,
      })
      .returning({ id: schema.apiKeys.id });
    const [host] = await tx
      .insert(schema.tachoHosts)
      .values({
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
        agentKey,
        apiKeyId: key!.id,
        hostname: over.hostname ?? "build-1",
        hostnameDigest: "sha256:host",
        platform: "linux",
        osUser: "ci",
        osUserDigest: "sha256:user",
        devicePublicKey: "ed25519:pub",
        deviceKeyFingerprint: `sha256:${Math.random().toString(36).slice(2)}`,
        harnesses: ["claude-code"],
        status,
        enrollmentClaims: {},
        enrollmentSignature: "sig",
        expiresAt: new Date(now.getTime() + 30 * DAY_MS),
        revokedAt: status === "revoked" ? now : null,
        createdById: tenant.userId,
        updatedById: tenant.userId,
      })
      .returning({
        id: schema.tachoHosts.id,
        publicId: schema.tachoHosts.publicId,
      });
    return { id: host!.id, publicId: host!.publicId, apiKeyId: key!.id };
  });
}

export async function seedIncident(
  tenant: SeededTenant,
  over: {
    hostId?: string | null;
    kind: string;
    severity?: 1 | 3 | 10;
    detectedAt?: Date;
    resolved?: boolean;
    workspaceId?: string;
  },
): Promise<{ id: string; publicId: string }> {
  return withSystemDb(async (tx) => {
    const [row] = await tx
      .insert(schema.tachoIncidents)
      .values({
        orgId: tenant.orgId,
        workspaceId: over.workspaceId ?? tenant.workspaceId,
        hostId: over.hostId ?? null,
        kind: over.kind,
        severity: over.severity ?? 10,
        detectedAt: over.detectedAt ?? new Date(),
        detectedBy: "collector",
        evidence: { seeded: true },
        resolvedAt: over.resolved ? new Date() : null,
        resolutionNote: over.resolved ? "seeded resolution" : null,
      })
      .returning({
        id: schema.tachoIncidents.id,
        publicId: schema.tachoIncidents.publicId,
      });
    return row!;
  });
}

/** A mandate held by the agent's principal; `active` unless told otherwise. */
export async function seedMandate(
  tenant: SeededTenant,
  agent: SeededAgent,
  over: {
    status?: "draft" | "active" | "expired" | "revoked";
    expired?: boolean;
  } = {},
): Promise<{ id: string }> {
  const status = over.status ?? "active";
  const now = Date.now();
  return withSystemDb(async (tx) => {
    const [row] = await tx
      .insert(schema.mandates)
      .values({
        orgId: tenant.orgId,
        workspaceId: tenant.workspaceId,
        agentPrincipalId: agent.principalId!,
        requestedBy: tenant.userId,
        grantedBy: status === "draft" ? null : tenant.userId,
        roleAtGrant: status === "draft" ? null : "Owner",
        consequenceTags: ["spend"],
        limits: {},
        tools: ["stripe__*"],
        purpose: "seeded mandate",
        validFrom: new Date(now - 10 * DAY_MS),
        validTo: over.expired
          ? new Date(now - DAY_MS)
          : new Date(now + 10 * DAY_MS),
        status,
        createdById: tenant.userId,
        updatedById: tenant.userId,
      })
      .returning({ id: schema.mandates.id });
    return row!;
  });
}

/** A root wrapped session under `agentKey`; priced when `costMicros` and a basis are given. */
export async function seedSession(
  tenant: SeededTenant,
  agentKey: string,
  over: {
    startedAt: Date;
    costMicros?: number;
    costBasis?: string | null;
    hasUnknownModelCost?: boolean;
    child?: boolean;
    /** Usage as the harness reported it; every class defaults to zero. */
    tokens?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheCreation?: number;
    };
  },
): Promise<void> {
  const sessionUuid = crypto.randomUUID();
  await withSystemDb(async (tx) => {
    await tx.insert(schema.tachoSessions).values({
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      sessionUuid,
      harnessSessionId: `h-${sessionUuid}`,
      agentKey,
      rootSessionUuid: over.child ? crypto.randomUUID() : sessionUuid,
      parentSessionUuid: over.child ? crypto.randomUUID() : null,
      runtime: "claude-code",
      harness: "claude-code",
      startedAt: over.startedAt,
      lastEventAt: over.startedAt,
      totalCostMicros: over.costMicros ?? 0,
      costBasis: over.costBasis ?? null,
      hasUnknownModelCost: over.hasUnknownModelCost ?? null,
      inputTokens: over.tokens?.input ?? 0,
      outputTokens: over.tokens?.output ?? 0,
      cacheReadTokens: over.tokens?.cacheRead ?? 0,
      cacheCreationTokens: over.tokens?.cacheCreation ?? 0,
    });
  });
}

/**
 * A v2 ledger run of the agent row: the typed identity set the CHECK requires,
 * as a `repo_edit` run so the row satisfies the constraint before and after
 * the general-run relaxation (20260914190000_agent_runs_general_run_identity).
 */
export async function seedLedgerRun(
  tenant: SeededTenant,
  agent: SeededAgent,
  startedAt: Date,
): Promise<void> {
  const digest = `sha256:${"0".repeat(64)}`;
  await withSystemDb(async (tx) => {
    await tx.insert(schema.agentRuns).values({
      orgId: tenant.orgId,
      workspaceId: tenant.workspaceId,
      surface: "external",
      spec: {},
      status: "completed",
      startedAt,
      createdAt: startedAt,
      specVersion: 2,
      runKind: "repo_edit",
      specDigest: digest,
      repositoryBindingId: crypto.randomUUID(),
      repositoryProvider: "github",
      providerRepositoryId: "1",
      repositoryConnectionId: crypto.randomUUID(),
      configuredDefaultRef: "main",
      baseCommitSha: "0".repeat(40),
      baseTreeSha: "0".repeat(40),
      initiatingPrincipalId: agent.principalId ?? crypto.randomUUID(),
      agentPrincipalId: agent.principalId ?? crypto.randomUUID(),
      agentId: agent.id,
      agentVersionId: crypto.randomUUID(),
      agentVersionChecksum: digest,
      authorizationSnapshotId: crypto.randomUUID(),
      retentionPolicyId: crypto.randomUUID(),
      retentionPolicyDigest: digest,
      maxAttempts: 1,
    });
  });
}

/** Remove everything the seeds wrote for these orgs. */
export async function cleanupTenants(orgIds: readonly string[]): Promise<void> {
  if (orgIds.length === 0) return;
  const ids = [...orgIds];
  await withSystemDb(async (tx) => {
    await tx.delete(schema.mandates).where(inArray(schema.mandates.orgId, ids));
    await tx
      .delete(schema.tachoControlCommands)
      .where(inArray(schema.tachoControlCommands.orgId, ids));
    await tx
      .delete(schema.tachoIncidents)
      .where(inArray(schema.tachoIncidents.orgId, ids));
    await tx
      .delete(schema.tachoSessions)
      .where(inArray(schema.tachoSessions.orgId, ids));
    await tx
      .delete(schema.tachoHosts)
      .where(inArray(schema.tachoHosts.orgId, ids));
    await tx
      .delete(schema.agentRuns)
      .where(inArray(schema.agentRuns.orgId, ids));
    const agents = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(inArray(schema.agents.orgId, ids));
    if (agents.length > 0) {
      await tx.delete(schema.agentVersions).where(
        inArray(
          schema.agentVersions.agentId,
          agents.map((a) => a.id),
        ),
      );
    }
    await tx.delete(schema.agents).where(inArray(schema.agents.orgId, ids));
    await tx
      .delete(schema.principalRoleAssignments)
      .where(inArray(schema.principalRoleAssignments.orgId, ids));
    await tx.delete(schema.roles).where(inArray(schema.roles.orgId, ids));
    await tx
      .delete(schema.principals)
      .where(inArray(schema.principals.orgId, ids));
    await tx.delete(schema.apiKeys).where(inArray(schema.apiKeys.orgId, ids));
    await tx
      .delete(schema.workspaces)
      .where(inArray(schema.workspaces.orgId, ids));
    await tx
      .delete(schema.organizations)
      .where(inArray(schema.organizations.id, ids));
  });
}

/** Remove the seeded users (kept apart from the org rows: a user is not org-owned). */
export async function cleanupUsers(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await withSystemDb(async (tx) => {
    await tx.delete(schema.users).where(inArray(schema.users.id, [...userIds]));
  });
}
