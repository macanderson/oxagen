// get_agent_toolbelt handler tests, against a real Postgres (the belt is a
// join of the registry with the agent's live authority: its principal, its
// role grants, the caller's grants, the entitlement read and the kill
// switches). The per-tool decision itself and its parity with the runtime
// listing are proven in packages/agent (runtime/toolbelt.test.ts and
// materialize-tools.test.ts). Runs where DATABASE_URL is set; locally:
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/agent.toolbelt.get.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import {
  FULL_BELT_LIMIT,
  agentToolbeltGet,
} from "@oxagen/oxagen/contracts/agent.toolbelt.get";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe.skipIf(!process.env.DATABASE_URL)(
  "get_agent_toolbelt against Postgres",
  async () => {
    const { withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq } = await import("drizzle-orm");
    const support = await import(
      "@oxagen/agent/handlers/_agent-identity.test-support"
    );
    const { agentToolbeltGetHandler } = await import("./agent.toolbelt.get");
    // The registry is loaded through the handlers' own contract imports; the
    // barrel below registers every contract so the agent surface is complete.
    await import("@oxagen/oxagen/contracts");

    type Tenant =
      import("@oxagen/agent/handlers/_agent-identity.test-support").SeededTenant;
    let tenant: Tenant;
    let granted: import("@oxagen/agent/handlers/_agent-identity.test-support").SeededAgent;
    let suspended: import("@oxagen/agent/handlers/_agent-identity.test-support").SeededAgent;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    const belt = (agentId: string, mode?: "full" | "searchable") =>
      runInTenantScope(
        { orgId: tenant.orgId, workspaceId: tenant.workspaceId },
        () =>
          agentToolbeltGetHandler(
            agentToolbeltGet.input.parse({
              agentId,
              ...(mode ? { mode } : {}),
            }),
            support.ctxFor(tenant, tenant.userId),
          ),
      );

    beforeAll(async () => {
      tenant = await support.seedTenant();
      orgIds.push(tenant.orgId);
      userIds.push(tenant.userId);
      // The caller holds an org role whose grants allow both tools below, so
      // the human side of the ceiling is not what decides.
      await support.seedMember(tenant, "Owner");
      granted = await support.seedAgent(tenant, { slug: "granted" });
      suspended = await support.seedAgent(tenant, {
        slug: "suspended",
        principalStatus: "suspended",
      });
      await support.seedAgent(tenant, { slug: "bare", principalStatus: null });
      await withSystemDb(async (tx) => {
        const [ownerRole] = await tx
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(eq(schema.roles.orgId, tenant.orgId));
        const [agentRole] = await tx
          .insert(schema.roles)
          .values({ orgId: tenant.orgId, scopeKind: "workspace", name: "Belt" })
          .returning({ id: schema.roles.id });
        await tx.insert(schema.principalRoleAssignments).values({
          principalId: granted.principalId!,
          roleId: agentRole!.id,
          orgId: tenant.orgId,
          workspaceId: tenant.workspaceId,
          assignedBy: tenant.userId,
        });
        await tx.insert(schema.roleGrants).values([
          // Two agent-surface reads: one allowed outright, one held for approval.
          {
            orgId: tenant.orgId,
            roleId: agentRole!.id,
            capabilityId: "list_agent_defs",
            effect: "allow",
          },
          {
            orgId: tenant.orgId,
            roleId: agentRole!.id,
            capabilityId: "list_agent_environments",
            effect: "require_approval",
          },
          {
            orgId: tenant.orgId,
            roleId: ownerRole!.id,
            capabilityId: "list_agent_defs",
            effect: "allow",
          },
          {
            orgId: tenant.orgId,
            roleId: ownerRole!.id,
            capabilityId: "list_agent_environments",
            effect: "allow",
          },
        ]);
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.roleGrants)
          .where(eq(schema.roleGrants.orgId, tenant.orgId));
      });
      await support.cleanupTenants(orgIds);
      await support.cleanupUsers(userIds);
    });

    it("places each agent-surface tool by the resolver's decision, with the caller as the human ceiling, and parses through the contract", async () => {
      const out = agentToolbeltGet.output.parse(await belt("granted"));
      expect(out.agentId).toBe(granted.publicId);
      expect(out.basis.humanCeiling).toBe("caller");
      expect(out.basis.roleGrants).toBeGreaterThanOrEqual(4);
      expect(out.basis.killSwitches).toBe(0);
      const byName = new Map(out.tools.map((t) => [t.name, t]));
      expect(byName.get("list_agent_defs")).toMatchObject({
        kind: "capability",
        decision: "allow",
        readOnly: true,
      });
      expect(byName.get("list_agent_defs")!.rule).toMatch(/^(agent|human):/);
      expect(byName.get("list_agent_environments")).toMatchObject({
        decision: "require_approval",
      });
      // A tool with no grant on the agent side is out of sight, with the
      // deciding step named; every excluded name is off the belt.
      const cut = out.cannotSee.find((c) => c.name === "delete_agent_def");
      expect(cut).toBeDefined();
      expect(cut!.rule).toMatch(/^agent:/);
      const names = new Set(out.tools.map((t) => t.name));
      expect(out.cannotSee.some((c) => names.has(c.name))).toBe(false);
      expect(out.presentation).toEqual({
        mode: out.tools.length <= FULL_BELT_LIMIT ? "full" : "searchable",
        limit: FULL_BELT_LIMIT,
        sentToModel:
          out.tools.length <= FULL_BELT_LIMIT ? "definitions" : "meta_tools",
      });
    });

    it("a forced presentation wins over the size rule", async () => {
      const out = await belt("granted", "searchable");
      expect(out.presentation).toMatchObject({
        mode: "searchable",
        sentToModel: "meta_tools",
      });
    });

    it("a suspended principal anchors no run: an empty belt, every tool out of sight as principal_suspended", async () => {
      const out = agentToolbeltGet.output.parse(await belt(suspended.publicId));
      expect(out.tools).toEqual([]);
      expect(out.basis.humanCeiling).toBe("sentinel");
      expect(out.cannotSee.length).toBeGreaterThan(0);
      expect(new Set(out.cannotSee.map((c) => c.rule))).toEqual(
        new Set(["principal_suspended"]),
      );
    });

    it("an agent with no delegated principal is a conflict; an unknown agent is not_found", async () => {
      await expect(belt("bare")).rejects.toSatisfy(
        (err: unknown) =>
          isHandlerError(err) &&
          err.code === "conflict" &&
          err.reason === "agent_principal_missing",
      );
      await expect(belt("nobody")).rejects.toSatisfy(
        (err: unknown) =>
          isHandlerError(err) &&
          err.code === "not_found" &&
          err.reason === "agent_not_found",
      );
    });
  },
);
