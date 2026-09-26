// pause_workspace_runs against a real Postgres: one pause row per live root
// session in the caller's workspace, an observe-tier run on a polling host
// included (ADR-163), and no row for a sealed session, a child session, a
// live session in another workspace of the same organization, or one in
// another organization. The decision is recorded as one security event in
// the same transaction. Runs wherever DATABASE_URL points at a migrated
// database. CI's `test` job migrates Postgres with Atlas first; a local run
// without one is skipped, not red. Every row it writes is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { pauseWorkspaceRuns } from "@oxagen/oxagen/contracts/tacho.workspace_runs.pause";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, inArray } from "drizzle-orm";
import { pauseWorkspaceRunsHandler } from "./tacho.workspace_runs.pause";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("pause_workspace_runs against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const otherOrgWorkspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const hostApiKeyId = crypto.randomUUID();
  const hostPublicId = `tch_${tag}00000000000000`;
  const agentKey = `p3862.core.bot-${tag}`;

  const keys = [
    "live",
    "observe",
    "sealed",
    "child",
    "otherWorkspace",
    "otherOrg",
  ] as const;
  type Key = (typeof keys)[number];
  const ids = Object.fromEntries(
    keys.map((k) => [k, crypto.randomUUID()]),
  ) as Record<Key, string>;
  const uuids = Object.fromEntries(
    keys.map((k) => [k, crypto.randomUUID()]),
  ) as Record<Key, string>;
  const publicIds = Object.fromEntries(
    keys.map((k, i) => [
      k,
      `tse_${tag}000000000000${String(i).padStart(2, "0")}`,
    ]),
  ) as Record<Key, string>;

  const operator: CapabilityContext = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: `req-${tag}`,
    surface: "api",
    messageId: null,
  };

  const pause = (reason: string) =>
    runInTenantScope({ orgId, workspaceId }, () =>
      pauseWorkspaceRunsHandler(
        pauseWorkspaceRuns.input.parse({ reason }),
        operator,
      ),
    );

  const session = (
    key: Key,
    over: {
      orgId?: string;
      workspaceId?: string;
      hostId?: string | null;
      outcome?: string;
      enforcementTier?: string;
      parentSessionUuid?: string;
      rootSessionUuid?: string;
    } = {},
  ) => ({
    id: ids[key],
    publicId: publicIds[key],
    orgId,
    workspaceId,
    sessionUuid: uuids[key],
    harnessSessionId: `sess-${key}-${tag}`,
    hostId,
    agentKey,
    rootSessionUuid: uuids[key],
    runtime: "claude-code",
    harness: "claude-code",
    outcome: "running",
    enforcementTier: "harness",
    startedAt: new Date("2026-09-25T09:00:00.000Z"),
    lastEventAt: new Date("2026-09-25T09:05:00.000Z"),
    ...over,
  });

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        email: `p3862-${tag}@handlers.test`,
        status: "active",
      });
      await tx.insert(schema.organizations).values([
        {
          id: orgId,
          name: `P3862 ${tag}`,
          slug: `p3862-${tag}`,
          namespace: `p${tag.slice(0, 5)}`,
          planType: "free",
          status: "active",
        },
        {
          id: otherOrgId,
          name: `P3862 other ${tag}`,
          slug: `p3862-other-${tag}`,
          namespace: `q${tag.slice(0, 5)}`,
          planType: "free",
          status: "active",
        },
      ]);
      await tx.insert(schema.workspaces).values([
        {
          id: workspaceId,
          orgId,
          name: "Core",
          slug: "core",
          namespace: "core",
        },
        {
          id: otherWorkspaceId,
          orgId,
          name: "Other",
          slug: "other",
          namespace: "other",
        },
        {
          id: otherOrgWorkspaceId,
          orgId: otherOrgId,
          name: "Core",
          slug: "core",
          namespace: "core",
        },
      ]);
      // The org Owner role the handler's gate resolves for the operator.
      const [principal] = await tx
        .insert(schema.principals)
        .values({
          orgId,
          kind: "human",
          displayName: "Operator",
          status: "active",
          parentUserId: userId,
        })
        .returning({ id: schema.principals.id });
      const [role] = await tx
        .insert(schema.roles)
        .values({ orgId, scopeKind: "org", name: "Owner" })
        .returning({ id: schema.roles.id });
      if (!principal || !role)
        throw new Error("fixture insert returned no row");
      await tx.insert(schema.principalRoleAssignments).values({
        principalId: principal.id,
        roleId: role.id,
        orgId,
      });
      await tx.insert(schema.apiKeys).values({
        id: hostApiKeyId,
        orgId,
        workspaceId,
        keyPrefix: `oxk_${tag}`,
        keyHash: `hash-${tag}`,
        name: `tacho host ${tag}`,
        scope: { purpose: "tacho_host_v1", host_enrollment_id: hostPublicId },
        createdById: userId,
      });
      await tx.insert(schema.tachoHosts).values({
        id: hostId,
        publicId: hostPublicId,
        orgId,
        workspaceId,
        agentKey,
        apiKeyId: hostApiKeyId,
        hostname: "laptop",
        hostnameDigest: "sha256:0",
        platform: "darwin",
        osUser: "dev",
        osUserDigest: "sha256:0",
        devicePublicKey: "pk",
        deviceKeyFingerprint: "fp",
        enrollmentClaims: {},
        enrollmentSignature: "sig",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        status: "active",
        mode: "enforce",
        // Polled a moment ago, so every run on it can take a command.
        lastSeenAt: new Date(),
        bundleFeatures: [],
      });
      await tx.insert(schema.tachoSessions).values([
        session("live"),
        session("observe", { enforcementTier: "observe" }),
        session("sealed", { outcome: "completed" }),
        session("child", {
          parentSessionUuid: uuids.live,
          rootSessionUuid: uuids.live,
        }),
        session("otherWorkspace", {
          workspaceId: otherWorkspaceId,
          hostId: null,
        }),
        session("otherOrg", {
          orgId: otherOrgId,
          workspaceId: otherOrgWorkspaceId,
          hostId: null,
        }),
      ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      const orgs = [orgId, otherOrgId];
      await tx
        .delete(schema.securityEvents)
        .where(inArray(schema.securityEvents.orgId, orgs));
      await tx
        .delete(schema.tachoControlCommands)
        .where(inArray(schema.tachoControlCommands.orgId, orgs));
      await tx
        .delete(schema.tachoSessions)
        .where(inArray(schema.tachoSessions.orgId, orgs));
      await tx
        .delete(schema.tachoHosts)
        .where(eq(schema.tachoHosts.id, hostId));
      await tx
        .delete(schema.apiKeys)
        .where(eq(schema.apiKeys.id, hostApiKeyId));
      await tx
        .delete(schema.principalRoleAssignments)
        .where(eq(schema.principalRoleAssignments.orgId, orgId));
      await tx
        .delete(schema.principals)
        .where(eq(schema.principals.orgId, orgId));
      await tx.delete(schema.roles).where(eq(schema.roles.orgId, orgId));
      await tx
        .delete(schema.workspaces)
        .where(inArray(schema.workspaces.orgId, orgs));
      await tx
        .delete(schema.organizations)
        .where(inArray(schema.organizations.id, orgs));
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
    await closeDatabase();
  });

  it("pauses the workspace's live root runs and nothing outside them, and records one event", async () => {
    const receipt = await pause("Incident 42");

    // The live harness run and the observe-tier run on the same polling host
    // both take the pause; nothing is skipped.
    expect(receipt.queued).toBe(2);
    expect(receipt.skipped).toEqual([]);

    const rows = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.tachoControlCommands)
        .where(inArray(schema.tachoControlCommands.orgId, [orgId, otherOrgId]))
        .orderBy(asc(schema.tachoControlCommands.publicId)),
    );
    expect(new Set(rows.map((r) => r.targetId))).toEqual(
      new Set([publicIds.live, publicIds.observe]),
    );
    expect(new Set(rows.map((r) => r.publicId))).toEqual(
      new Set(receipt.commandIds),
    );
    for (const row of rows)
      expect(row).toMatchObject({
        orgId,
        workspaceId,
        hostId,
        targetKind: "run",
        command: "pause",
        reason: "Incident 42",
        outcome: "queued",
        issuedByUserId: userId,
      });

    const events = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.securityEvents)
        .where(
          and(
            eq(schema.securityEvents.orgId, orgId),
            eq(schema.securityEvents.eventType, "tacho.workspace_runs_paused"),
          ),
        ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: userId,
      workspaceId,
      capability: "pause_workspace_runs",
      outcome: "success",
      requestId: `req-${tag}`,
      detail: {
        reason: "Incident 42",
        queued: 2,
        skipped: [],
      },
    });
  });
});
