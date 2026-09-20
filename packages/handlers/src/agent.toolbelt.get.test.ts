// get_agent_toolbelt handler tests, against a real Postgres (the belt is a
// join of the registry with the agent's live authority: its principal, its
// role grants, the caller's grants, the entitlement read and the kill
// switches). The per-tool decision itself and its parity with the runtime
// listing are proven in packages/agent (runtime/toolbelt.test.ts and
// materialize-tools.test.ts); the MCP servers are selected by the runtime's
// own query (runtime/mcp-servers.ts), proven here against the rows the two
// diverging writers leave behind. Runs where DATABASE_URL is set; locally:
//
//   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
//     pnpm --filter @oxagen/handlers exec vitest run src/agent.toolbelt.get.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import { createHash } from "node:crypto";
import {
  BELT_SCHEMA_BYTE_LIMIT,
  FULL_BELT_LIMIT,
  agentToolbeltGet,
  beltToolSchema,
} from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import { beltSchemaFacts } from "./agent.toolbelt.get";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("beltSchemaFacts", () => {
  const sha = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");

  it("digests the canonical schema, so key order is not identity", () => {
    const one = beltSchemaFacts(
      { type: "object", properties: { b: {}, a: {} } },
      "declared",
      { tool: "t" },
    );
    const two = beltSchemaFacts(
      { properties: { a: {}, b: {} }, type: "object" },
      "declared",
      { tool: "t" },
    );
    expect(one.schemaDigest).toBe(two.schemaDigest);
    expect(one.schemaDigest).toBe(
      sha('{"properties":{"a":{},"b":{}},"type":"object"}'),
    );
    expect(one).toMatchObject({
      schemaOrigin: "declared",
      schemaTruncated: false,
    });
    expect(one.inputSchema).toEqual({
      type: "object",
      properties: { b: {}, a: {} },
    });
  });

  it("carries a schema over the cap as its digest alone", () => {
    const big = {
      type: "object",
      description: "x".repeat(BELT_SCHEMA_BYTE_LIMIT),
    };
    const facts = beltSchemaFacts(big, "imported", { tool: "srv__big" });
    expect(facts.inputSchema).toBeNull();
    expect(facts.schemaTruncated).toBe(true);
    expect(facts.schemaOrigin).toBe("imported");
    expect(facts.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports no schema for a value that is not a JSON Schema object", () => {
    for (const value of [null, undefined, "{}", 7, [{ type: "object" }]]) {
      expect(beltSchemaFacts(value, "declared", { tool: "t" })).toEqual({
        inputSchema: null,
        schemaOrigin: null,
        schemaDigest: null,
        schemaTruncated: false,
      });
    }
  });

  it("reports no schema, rather than failing the read, for a row with no canonical form", () => {
    const facts = beltSchemaFacts({ type: new Map() }, "imported", {
      tool: "srv__broken",
    });
    expect(facts.schemaDigest).toBeNull();
    expect(facts.inputSchema).toBeNull();
  });

  it("parses through the contract on a belt entry", () => {
    const entry = {
      name: "list_agent_defs",
      kind: "capability" as const,
      server: null,
      category: null,
      riskLevel: "low" as const,
      decision: "allow" as const,
      rule: "agent:7:role_grant",
      readOnly: true,
      ...beltSchemaFacts({ type: "object" }, "declared", { tool: "x" }),
    };
    expect(() => beltToolSchema.parse(entry)).not.toThrow();
    // The fields are optional: an entry written before them still parses.
    const { inputSchema, schemaOrigin, schemaDigest, schemaTruncated, ...old } =
      entry;
    expect(() => beltToolSchema.parse(old)).not.toThrow();
    expect([inputSchema, schemaOrigin, schemaDigest, schemaTruncated]).toEqual([
      { type: "object" },
      "declared",
      sha('{"type":"object"}'),
      false,
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "get_agent_toolbelt against Postgres",
  async () => {
    const { withSystemDb } = await import("@oxagen/database");
    const { runInTenantScope } = await import("@oxagen/tenancy");
    const { eq, inArray } = await import("drizzle-orm");
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
      // Four MCP servers, each with one cached tool. "live" is installed and
      // enabled. "offplugin" is enabled while its install row is off (what
      // set_plugin_enabled at org scope leaves). "unlisted" has no install row
      // (what register_mcp_server writes), and is healthy so the missing
      // listing is the only difference from a plugin-installed server.
      await withSystemDb(async (tx) => {
        const installs = await tx
          .insert(schema.pluginInstalledPlugins)
          .values(
            (["live", "offplugin"] as const).map((name) => ({
              orgId: tenant.orgId,
              workspaceId: tenant.workspaceId,
              pluginType: "mcp_server",
              source: "custom",
              name,
              authKind: "none",
              enabled: name === "live",
            })),
          )
          .returning({
            id: schema.pluginInstalledPlugins.id,
            name: schema.pluginInstalledPlugins.name,
          });
        const listing = new Map(installs.map((row) => [row.name, row.id]));
        await tx.insert(schema.mcpServers).values(
          (["live", "offplugin", "unlisted", "stdio"] as const).map((name) => ({
            orgId: tenant.orgId,
            workspaceId: tenant.workspaceId,
            orgListingId: listing.get(name) ?? null,
            name,
            transportType: name === "stdio" ? "stdio" : "streamable-http",
            endpointUrl: `https://${name}.mcp.example.com`,
            authStrategy: "none",
            healthStatus: name === "live" ? "unknown" : "healthy",
            discoveredTools: ["ping"],
          })),
        );
      });
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
        await tx
          .delete(schema.mcpServers)
          .where(inArray(schema.mcpServers.orgId, orgIds));
        await tx
          .delete(schema.pluginInstalledPlugins)
          .where(inArray(schema.pluginInstalledPlugins.orgId, orgIds));
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
      // A capability carries the schema the model is handed, derived from the
      // contract, with the digest that identifies it.
      const withSchema = byName.get("list_agent_defs")!;
      expect(withSchema.schemaOrigin).toBe("declared");
      expect(withSchema.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(withSchema.schemaTruncated).toBe(false);
      expect(withSchema.inputSchema).toMatchObject({ type: "object" });
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

    it("lists standalone HTTP servers but excludes disabled installs", async () => {
      const out = agentToolbeltGet.output.parse(await belt("granted"));
      // The server's cached tools/list snapshot holds names only, and these
      // tools were never imported into the registry, so the entry reports no
      // schema rather than a placeholder.
      expect(out.tools.find((t) => t.name === "live__ping")).toMatchObject({
        kind: "mcp",
        category: "external",
        inputSchema: null,
        schemaOrigin: null,
        schemaDigest: null,
        schemaTruncated: false,
      });
      const listed = [
        ...out.tools.map((t) => t.name),
        ...out.cannotSee.map((c) => c.name),
      ];
      expect(listed).not.toContain("offplugin__ping");
      expect(listed).not.toContain("stdio__ping");
      expect(listed).toContain("unlisted__ping");
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
