// Contract test against a real Postgres: seeds one row per table the live tools
// adapter reads, in a throwaway organization and workspace, reads it back
// through the port (the real kernel and handlers decide each read; no IAM
// runtime is bootstrapped here, so the kernel allows), and removes it. Opt-in,
// because unit runs have no database:
//
//   MC_LIVE_PG=1 DATABASE_URL=postgres://oxagen:…@localhost:5433/oxagen \
//     pnpm --filter @oxagen/app exec vitest run src/data/adapters/live/tools.pg.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Connection,
  ConnectionKind,
  Count,
  Day,
  DownscopeMethod,
  KillSwitch,
  ToolServer,
  ToolVersion,
} from "@/data/contracts";

const enabled = process.env.MC_LIVE_PG === "1";

describe.skipIf(!enabled)("live tools adapter against Postgres", async () => {
  const { schema, withSystemDb } = await import("@oxagen/database");
  const { and, eq } = await import("drizzle-orm");
  const { createLiveTools, liveToolsDeps, postgresToolsStore } = await import(
    "./tools"
  );

  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const T0 = new Date("2026-09-10T08:00:00.000Z");
  const T1 = new Date("2026-09-11T09:14:02.000Z");
  const listing = crypto.randomUUID();
  let owner: { id: string; publicId: string } | undefined;
  const report = vi.fn();

  // The promote list's contract change: unrecorded fields accepted as null.
  const views = {
    ToolServer: ToolServer.extend({
      health: ToolServer.shape.health.nullable(),
      transport: ToolServer.shape.transport.nullable(),
      pendingSchemaCount: Count.nullable(),
    }),
    ToolVersion: ToolVersion.extend({
      name: z.string().nullable(),
      serverId: z.string().nullable(),
      risk: ToolVersion.shape.risk.nullable(),
      sideEffect: ToolVersion.shape.sideEffect.nullable(),
      egress: ToolVersion.shape.egress.nullable(),
      consequenceTags: ToolVersion.shape.consequenceTags.nullable(),
      credential: z.object({
        connectionKind: ConnectionKind.nullable(),
        downscope: DownscopeMethod.nullable(),
      }),
      beltCount: Count.nullable(),
      calls30d: Count.nullable(),
    }),
    Connection: Connection.extend({
      kind: ConnectionKind.nullable(),
      name: z.string().nullable(),
      ownerId: z.string().nullable(),
      reviewedOn: Day.nullable(),
      reviewOn: Day.nullable(),
      grants30d: Count.nullable(),
      status: Connection.shape.status.nullable(),
      downscope: DownscopeMethod.nullable(),
    }),
    KillSwitch,
  } as unknown as NonNullable<Parameters<typeof createLiveTools>[0]["views"]>;

  /** The production deps, signed in as the seeded owner (no request session here). */
  const portFor = (
    overrides: Partial<Parameters<typeof createLiveTools>[0]> = {},
  ) =>
    createLiveTools({
      ...liveToolsDeps,
      principal: () => Promise.resolve(owner?.id ?? crypto.randomUUID()),
      report,
      ...overrides,
    });

  beforeAll(async () => {
    console.info(
      `seeding tools rows into ${String(process.env.DATABASE_URL).replace(/:[^:@/]+@/, ":***@")}`,
    );
    await withSystemDb(async (tx) => {
      const [user] = await tx
        .select({ id: schema.users.id, publicId: schema.users.publicId })
        .from(schema.users)
        .limit(1);
      owner = user;
      const [server] = await tx
        .insert(schema.mcpServers)
        .values({
          ...scope,
          orgListingId: listing,
          name: "GitHub",
          transportType: "streamable-http",
          endpointUrl: "https://api.githubcopilot.com/mcp/",
          authStrategy: "bearer",
          healthStatus: "healthy",
          discoveredTools: [{ name: "create_pull_request" }],
        })
        .returning({ id: schema.mcpServers.id });
      if (!server) throw new Error("server not seeded");
      const descriptor = {
        name: "create_pull_request",
        description: "Open a pull request",
        inputSchema: { type: "object" },
      };
      await tx.insert(schema.mcpToolSnapshots).values([
        {
          ...scope,
          mcpServerId: server.id,
          toolName: "create_pull_request",
          schemaJson: descriptor,
          capturedAt: T0,
        },
        // A re-enable re-captures the same descriptor: still one version.
        {
          ...scope,
          mcpServerId: server.id,
          toolName: "create_pull_request",
          schemaJson: descriptor,
          capturedAt: T1,
        },
      ]);
      await tx.insert(schema.mcpCredentials).values({
        ...scope,
        orgListingId: listing,
        authKind: "oauth",
        status: "active",
        createdByUserId: owner?.id ?? null,
      });
      const [tool] = await tx
        .insert(schema.tools)
        .values({
          ...scope,
          name: "Deploy preview",
          slug: "deploy_preview",
          source: "custom",
        })
        .returning({ id: schema.tools.id });
      if (!tool) throw new Error("tool not seeded");
      await tx.insert(schema.toolVersions).values({
        ...scope,
        toolId: tool.id,
        versionNumber: 1,
        isLatest: true,
        inputSchema: { type: "object" },
        readOnly: true,
        riskGrade: "low",
        manifest: { name: "deploy_preview" },
        checksum: "c".repeat(64),
      });
      await tx.insert(schema.sourceConnections).values({
        ...scope,
        connectorId: "linear",
        displayName: "Linear",
        authScheme: "api_key",
        deliveryMethod: "poll",
        status: "connected",
        createdByUserId: owner?.id ?? null,
      });
      await tx.insert(schema.emergencyDenies).values({
        orgId: scope.orgId,
        workspaceId: null,
        scopeKind: "org",
        denyKind: "capability",
        capabilityId: "dispatch_tacho_command",
        reason: "credential probe from an unenrolled host",
        activatedAt: T1,
        createdByUserId: owner?.id ?? null,
      });
    });
  });

  afterAll(async () => {
    const { orgId, workspaceId } = scope;
    await withSystemDb(async (tx) => {
      const snap = schema.mcpToolSnapshots;
      await tx
        .delete(snap)
        .where(and(eq(snap.orgId, orgId), eq(snap.workspaceId, workspaceId)));
      const cred = schema.mcpCredentials;
      await tx
        .delete(cred)
        .where(and(eq(cred.orgId, orgId), eq(cred.workspaceId, workspaceId)));
      const srv = schema.mcpServers;
      await tx
        .delete(srv)
        .where(and(eq(srv.orgId, orgId), eq(srv.workspaceId, workspaceId)));
      const tv = schema.toolVersions;
      await tx
        .delete(tv)
        .where(and(eq(tv.orgId, orgId), eq(tv.workspaceId, workspaceId)));
      const tl = schema.tools;
      await tx
        .delete(tl)
        .where(and(eq(tl.orgId, orgId), eq(tl.workspaceId, workspaceId)));
      const sc = schema.sourceConnections;
      await tx
        .delete(sc)
        .where(and(eq(sc.orgId, orgId), eq(sc.workspaceId, workspaceId)));
      await tx
        .delete(schema.emergencyDenies)
        .where(eq(schema.emergencyDenies.orgId, orgId));
      await tx
        .delete(schema.authorizationDenyGenerations)
        .where(eq(schema.authorizationDenyGenerations.orgId, orgId));
    });
  });

  it("killSwitches parses the seeded deny through the KillSwitch view model", async () => {
    await expect(portFor().killSwitches(scope)).resolves.toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          level: "tool_version",
          target: "dispatch_tacho_command",
          on: true,
          flippedById: owner?.publicId ?? null,
          flippedAt: T1.toISOString(),
          reason: "credential probe from an unenrolled host",
        }),
      ],
    });
  });

  it.each(["servers", "toolVersions", "connections"] as const)(
    "%s is not backed under today's contract",
    async (method) => {
      await expect(portFor()[method](scope)).resolves.toMatchObject({
        ok: false,
        reason: "not_backed",
      });
    },
  );

  it("servers, toolVersions and connections parse the seeded rows once the contract widens", async () => {
    const port = portFor({ views });
    const servers = await port.servers(scope);
    expect(servers).toMatchObject({
      ok: true,
      value: [
        {
          name: "GitHub",
          transport: "streamable_http",
          toolCount: 1,
          versionCount: 1,
          status: "active",
          health: "ok",
          lastImportAt: T1.toISOString(),
          pendingSchemaCount: null,
        },
      ],
    });
    const serverId = servers.ok ? servers.value[0]?.id : undefined;
    expect(servers.ok && servers.value[0]?.connectionId).toMatch(/^mcrd_/);

    const versions = await port.toolVersions(scope);
    expect(
      versions.ok &&
        versions.value.map((v) => [
          v.name,
          v.version,
          v.schemaOrigin,
          v.serverId,
        ]),
    ).toEqual([
      ["deploy_preview", "1", "declared", null],
      ["create_pull_request", "1", "imported", serverId],
    ]);

    const connections = await port.connections(scope);
    expect(
      connections.ok &&
        connections.value.map((c) => [
          c.kind,
          c.name,
          c.status,
          c.serverIds,
          c.ownerId,
        ]),
    ).toEqual([
      ["api_key", "Linear", "active", [], owner?.publicId ?? null],
      ["oauth", "GitHub", "active", [serverId], owner?.publicId ?? null],
    ]);
    expect(report).not.toHaveBeenCalled();
  });

  it("the store reads nothing outside the grant the capabilities returned", async () => {
    const empty = {
      serverPublicIds: [],
      toolPublicIds: [],
      connectionPublicIds: [],
    };
    await expect(postgresToolsStore.servers(scope, empty)).resolves.toEqual([]);
    await expect(
      postgresToolsStore.toolVersions(scope, empty),
    ).resolves.toEqual({ declared: [], imported: [] });
    const connections = await postgresToolsStore.connections(scope, empty);
    expect(connections.sources).toEqual([]);
    // The credential stays (list_mcp_servers allowed it) but no server is attached.
    expect(connections.credentials.map((c) => c.server)).toEqual([null]);
  });
});
