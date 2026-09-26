// get_agent handler tests, against a real Postgres (see agent.list.test.ts
// for why and how to run the block locally).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { agentGet } from "@oxagen/oxagen/contracts/agent.get";

describe.skipIf(!process.env.DATABASE_URL)(
  "get_agent against Postgres",
  async () => {
    const { schema, withSystemDb } = await import("@oxagen/database");
    const { and, eq } = await import("drizzle-orm");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { agentGetHandler } = await import("./agent.get");
    const support = await import("./_agent-identity.test-support");

    const DAY_MS = 24 * 60 * 60 * 1000;
    let tenant: import("./_agent-identity.test-support").SeededTenant;
    let other: import("./_agent-identity.test-support").SeededTenant;
    let alpha: import("./_agent-identity.test-support").SeededAgent;
    let bare: import("./_agent-identity.test-support").SeededAgent;
    let hostPublicId = "";
    let laptop: Awaited<ReturnType<typeof support.seedRuntime>>;
    let cloud: Awaited<ReturnType<typeof support.seedRuntime>>;
    let allTools: Awaited<ReturnType<typeof support.seedToolbelt>>;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    const get = (t: typeof tenant, agentId: string) =>
      runInTenantScope({ orgId: t.orgId, workspaceId: t.workspaceId }, () =>
        agentGetHandler({ agentId }, support.ctxFor(t, t.userId)),
      );

    beforeAll(async () => {
      tenant = await support.seedTenant();
      other = await support.seedTenant();
      orgIds.push(tenant.orgId, other.orgId);
      userIds.push(tenant.userId, other.userId);
      const now = Date.now();

      laptop = await support.seedRuntime(tenant, {
        name: "Mac's laptop",
        slug: "macs-laptop",
      });
      cloud = await support.seedRuntime(tenant, {
        name: "Cloud VM",
        slug: "cloud-vm",
      });
      allTools = await support.seedToolbelt(tenant);
      alpha = await support.seedAgent(tenant, {
        slug: "alpha",
        name: "Alpha",
        harness: "stella",
        status: "active",
        costCenter: "ENG-1001",
        runtimeId: cloud.id,
        toolbeltId: allTools.id,
      });
      await support.seedCredential(tenant, alpha, { name: "live" });
      await support.seedCredential(tenant, alpha, {
        name: "old",
        revoked: true,
      });
      const host = await support.seedHost(tenant, alpha.agentKey!);
      hostPublicId = host.publicId;
      await support.seedSession(tenant, alpha.agentKey!, {
        startedAt: new Date(now - 90 * DAY_MS),
      });
      await support.seedLedgerRun(tenant, alpha, new Date(now - 10 * DAY_MS));
      // A role on the principal: one live, one expired.
      await withSystemDb(async (tx) => {
        const roles = await tx
          .insert(schema.roles)
          .values([
            {
              orgId: tenant.orgId,
              scopeKind: "workspace",
              name: "AgentDefault",
              isSystemDefault: true,
            },
            { orgId: tenant.orgId, scopeKind: "org", name: "Expired" },
          ])
          .returning({ id: schema.roles.id, name: schema.roles.name });
        await tx.insert(schema.principalRoleAssignments).values(
          roles.map((r) => ({
            principalId: alpha.principalId!,
            roleId: r.id,
            orgId: tenant.orgId,
            workspaceId: r.name === "AgentDefault" ? tenant.workspaceId : null,
            assignedBy: tenant.userId,
            expiresAt: r.name === "Expired" ? new Date(now - DAY_MS) : null,
          })),
        );
        // Three versions: a legacy row, the registration on the laptop, and
        // the move to the cloud VM (ADR-192).
        await tx.insert(schema.agentVersions).values([
          {
            agentId: alpha.id,
            version: 1,
            isPublished: true,
            config: { legacy: true },
            createdById: tenant.userId,
          },
          {
            agentId: alpha.id,
            version: 2,
            config: {},
            createdById: tenant.userId,
            changeKind: "registered",
            runtimeId: laptop.id,
            toolbeltId: allTools.id,
          },
          {
            agentId: alpha.id,
            version: 3,
            // The limits the migration copied out of the definition file.
            config: {
              budget: { per_run_micros: 2_500_000, per_day_micros: 40_000_000 },
              containment: { required: true },
            },
            createdById: tenant.userId,
            changeKind: "runtime_changed",
            runtimeId: cloud.id,
            toolbeltId: allTools.id,
          },
        ]);
        const [active] = await tx
          .select({ id: schema.agentVersions.id })
          .from(schema.agentVersions)
          .where(
            and(
              eq(schema.agentVersions.agentId, alpha.id),
              eq(schema.agentVersions.version, 3),
            ),
          );
        await tx
          .update(schema.agents)
          .set({ activeVersionId: active!.id })
          .where(eq(schema.agents.id, alpha.id));
      });
      bare = await support.seedAgent(tenant, {
        slug: "bare",
        principalStatus: null,
        operatorUserId: null,
      });
      await support.seedAgent(other, { slug: "alpha" });
    });

    afterAll(async () => {
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    it("reads the identity with its credentials, live roles, hosts, binding and versions", async () => {
      const out = agentGet.output.parse(await get(tenant, "alpha"));
      expect(out.identity).toMatchObject({
        id: alpha.publicId,
        slug: "alpha",
        name: "Alpha",
        harness: "stella",
        principalId: alpha.principalPublicId,
        operatorId: tenant.userPublicId,
        status: "enrolled",
        costCenter: "ENG-1001",
      });
      // The earliest run either store recorded, the window ignored.
      expect(out.identity.firstFrameAt).not.toBeNull();
      expect(
        Date.now() - Date.parse(out.identity.firstFrameAt!),
      ).toBeGreaterThan(89 * DAY_MS);
      expect(
        out.credentials.map((c) => [c.name, c.revokedAt === null]),
      ).toEqual([
        ["live", true],
        ["old", false],
      ]);
      expect(out.roles.map((r) => r.name)).toEqual(["AgentDefault"]);
      expect(out.roles[0]!.scopeKind).toBe("workspace");
      expect(out.hosts.map((h) => h.hostEnrollmentId)).toEqual([hostPublicId]);
      expect(out.hosts[0]!.hooksOk).toBeNull();
      expect(out.runtime).toEqual({
        id: cloud.publicId,
        name: "Cloud VM",
        slug: "cloud-vm",
      });
      expect(out.toolbelt).toEqual({
        id: allTools.publicId,
        name: "All tools",
        slug: "all-tools",
        kind: "all_tools",
      });
      // Newest first. The move kept the principal and wrote a version; the
      // legacy row names no binding rather than borrowing the current one.
      expect(
        out.versions.map((v) => [v.version, v.changeKind, v.runtime?.slug]),
      ).toEqual([
        [3, "runtime_changed", "cloud-vm"],
        [2, "registered", "macs-laptop"],
        [1, "legacy", undefined],
      ]);
      expect(out.versions[2]!.toolbelt).toBeNull();
      expect(out.versions[0]!.createdBy).toBe(tenant.userPublicId);
      // The ceilings the host bundle enforces, read from the active version.
      expect(out.limits).toEqual({
        perRun: { micros: "2500000", currency: "USD" },
        perDay: { micros: "40000000", currency: "USD" },
        containmentRequired: true,
        invalid: false,
      });
    });

    it("resolves by public id as well as by slug", async () => {
      const out = await get(tenant, alpha.publicId);
      expect(out.identity.slug).toBe("alpha");
    });

    it("an agent with no principal, runtime or version reads with nulls, not zeros or a borrowed binding", async () => {
      const out = agentGet.output.parse(await get(tenant, "bare"));
      expect(out.identity.id).toBe(bare.publicId);
      expect(out.identity.principalId).toBeNull();
      expect(out.identity.operatorId).toBeNull();
      expect(out.identity.status).toBe("unenrolled");
      expect(out.identity.firstFrameAt).toBeNull();
      expect(out.identity.costCenter).toBeNull();
      expect(out.roles).toEqual([]);
      expect(out.runtime).toBeNull();
      expect(out.versions).toEqual([]);
      // No belt named on the row: the workspace's All tools belt.
      expect(out.toolbelt?.kind).toBe("all_tools");
      // No active version: no ceiling to report.
      expect(out.limits).toEqual({
        perRun: null,
        perDay: null,
        containmentRequired: false,
        invalid: false,
      });
    });

    it("another org's agent of the same slug is not found from this workspace", async () => {
      await expect(get(other, alpha.publicId)).rejects.toSatisfy(
        (err: unknown) =>
          isHandlerError(err) &&
          err.code === "not_found" &&
          err.reason === "agent_not_found",
      );
      const theirs = await get(other, "alpha");
      expect(theirs.identity.id).not.toBe(alpha.publicId);
      expect(theirs.credentials).toEqual([]);
    });
  },
);
