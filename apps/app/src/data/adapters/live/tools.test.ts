import { requireScope } from "@oxagen/tenancy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { backingOf } from "@/data/backing";
import {
  Connection,
  Count,
  ConnectionKind,
  DownscopeMethod,
  Day,
  EgressClass,
  ConsequenceTag,
  KillSwitch,
  Risk,
  SideEffect,
  ToolServer,
  ToolVersion,
} from "@/data/contracts";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { PAGE_FAILURES } from "@/data/page-states";
import type { ServerSource } from "./mappers/tools";

// The fake transaction answers each `select … from(<table>)` with the rows the
// test registered for that table, and records that it ran inside tenant scope.
type Rows = Record<string, unknown>[];
const results = new Map<unknown, Rows>();
const scopesSeen: Array<{ orgId: string; workspaceId: string }> = [];

function builder() {
  let table: unknown;
  const b = {
    from(t: unknown) {
      table = t;
      return b;
    },
    innerJoin: () => b,
    leftJoin: () => b,
    where: () => b,
    groupBy: () => b,
    orderBy: () => b,
    // biome-ignore lint/suspicious/noThenProperty: a drizzle query is a thenable; the fake must be one too.
    then<R>(resolve: (rows: Rows) => R) {
      return Promise.resolve(results.get(table) ?? []).then(resolve);
    },
  };
  return b;
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...actual,
    withTenantDb: (fn: (tx: unknown) => unknown) => {
      const { orgId, workspaceId } = requireScope();
      scopesSeen.push({ orgId, workspaceId });
      return fn({ select: () => builder() });
    },
  };
});

const { schema } = await import("@oxagen/database");
const {
  TOOL_REGISTRY_UNMAPPABLE,
  WORKSPACE_SCOPE_REQUIRED,
  createLiveTools,
  liveTools,
  postgresToolsStore,
  reportToTelemetry,
} = await import("./tools");

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const T0 = new Date("2026-09-10T08:00:00.000Z");
const T1 = new Date("2026-09-11T09:14:02.000Z");

// Rows as the store's selects return them (a subset of each $inferSelect).
const serverRow = {
  publicId: "mcs_01k5rsgithub0000000000",
  name: "GitHub",
  transportType: "streamable-http",
  endpointUrl: "https://api.githubcopilot.com/mcp/",
  healthStatus: "healthy",
  discoveredTools: [{ name: "create_pull_request" }],
  enabled: true,
  orgListingId: "0192d4a8-7c1e-7a00-8000-00000000715d",
} satisfies Partial<typeof schema.mcpServers.$inferSelect>;
const descriptorRows = [
  {
    serverPublicId: serverRow.publicId,
    toolName: "create_pull_request",
    schemaJson: { name: "create_pull_request", inputSchema: {} },
    firstCapturedAt: T0,
    lastCapturedAt: T1,
  },
  {
    serverPublicId: serverRow.publicId,
    toolName: "list_issues",
    schemaJson: { name: "list_issues", inputSchema: {} },
    firstCapturedAt: T0,
    lastCapturedAt: T0,
  },
];
const denyRow = {
  publicId: "emd_01k5rsdeny00000000000",
  denyKind: "capability",
  capabilityId: "dispatch_tacho_command",
  resourceScopeDigest: null,
  principalId: null,
  reason: "credential probe from an unenrolled host",
  active: true,
  activatedAt: T1,
  deactivatedAt: null,
  activatedByPublicId: "usr_01k5rsdana00000000000",
  deactivatedByPublicId: null,
} satisfies Partial<typeof schema.emergencyDenies.$inferSelect> &
  Record<string, unknown>;

/**
 * The view models with the unrecorded fields widened to nullable: the contract
 * change on the promote list. A read that settles through these proves the
 * mapped real row is otherwise valid, field for field.
 */
const WIDENED = {
  ToolServer: ToolServer.extend({
    health: ToolServer.shape.health.nullable(),
    transport: ToolServer.shape.transport.nullable(),
    pendingSchemaCount: Count.nullable(),
  }),
  ToolVersion: ToolVersion.extend({
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .nullable(),
    serverId: z.string().nullable(),
    risk: Risk.nullable(),
    sideEffect: SideEffect.nullable(),
    egress: EgressClass.nullable(),
    consequenceTags: z.array(ConsequenceTag).nullable(),
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
  KillSwitch: KillSwitch.extend({ level: KillSwitch.shape.level.nullable() }),
} as unknown as NonNullable<Parameters<typeof createLiveTools>[0]["views"]>;

beforeEach(() => {
  results.clear();
  scopesSeen.length = 0;
});

const report = vi.fn();

function withStore(overrides: Partial<typeof postgresToolsStore> = {}) {
  return { ...postgresToolsStore, ...overrides };
}

describe("postgres tools store", () => {
  it("servers: counts distinct descriptors, the newest capture and the listing's credential, inside tenant scope", async () => {
    results.set(schema.mcpServers, [serverRow]);
    results.set(schema.mcpToolSnapshots, descriptorRows);
    results.set(schema.mcpCredentials, [
      {
        publicId: "mcrd_other0000000000000",
        orgListingId: "0192d4a8-7c1e-7a00-8000-000000000000",
      },
      {
        publicId: "mcrd_01k5rsgithubcred00000",
        orgListingId: serverRow.orgListingId,
      },
    ]);
    const { orgListingId: _listing, ...server } = serverRow;
    await expect(postgresToolsStore.servers(SCOPE)).resolves.toEqual<
      ServerSource[]
    >([
      {
        server,
        snapshots: { descriptorCount: 2, lastCapturedAt: T1 },
        credentialPublicId: "mcrd_01k5rsgithubcred00000",
      },
    ]);
    expect(scopesSeen).toEqual([SCOPE]);
  });

  it("servers: a server with no listing or no snapshots has no credential and no import", async () => {
    results.set(schema.mcpServers, [{ ...serverRow, orgListingId: null }]);
    results.set(schema.mcpCredentials, [
      {
        publicId: "mcrd_01k5rsgithubcred00000",
        orgListingId: serverRow.orgListingId,
      },
    ]);
    const [src] = await postgresToolsStore.servers(SCOPE);
    expect(src?.credentialPublicId).toBeNull();
    expect(src?.snapshots).toEqual({
      descriptorCount: 0,
      lastCapturedAt: null,
    });
  });

  it("toolVersions: splits declared rows into tool and version, and keeps first captures", async () => {
    results.set(schema.toolVersions, [
      {
        slug: "deploy_preview",
        source: "custom",
        versionNumber: 1,
        riskGrade: "low",
        readOnly: true,
        checksum: "c".repeat(64),
      },
    ]);
    results.set(schema.mcpToolSnapshots, descriptorRows);
    const out = await postgresToolsStore.toolVersions(SCOPE);
    expect(out.declared).toEqual([
      {
        tool: { slug: "deploy_preview", source: "custom" },
        version: {
          versionNumber: 1,
          riskGrade: "low",
          readOnly: true,
          checksum: "c".repeat(64),
        },
      },
    ]);
    expect(out.imported[0]).toEqual({
      serverPublicId: serverRow.publicId,
      toolName: "create_pull_request",
      schemaJson: descriptorRows[0]?.schemaJson,
      firstCapturedAt: T0,
    });
    expect(scopesSeen).toEqual([SCOPE]);
  });

  it("connections: attaches owners and the server a credential backs", async () => {
    results.set(schema.sourceConnections, [
      {
        publicId: "con_01k5rslinear0000000000",
        displayName: "Linear",
        authScheme: "api_key",
        status: "connected",
        ownerPublicId: null,
      },
    ]);
    results.set(schema.mcpCredentials, [
      {
        publicId: "mcrd_a0000000000000000000",
        authKind: "oauth",
        status: "active",
        ownerPublicId: "usr_01k5rsmarcus0000000000",
        serverPublicId: serverRow.publicId,
        serverName: "GitHub",
      },
      {
        publicId: "mcrd_b0000000000000000000",
        authKind: "secret",
        status: "revoked",
        ownerPublicId: null,
        serverPublicId: null,
        serverName: null,
      },
    ]);
    const out = await postgresToolsStore.connections(SCOPE);
    expect(out.sources).toEqual([
      {
        connection: {
          publicId: "con_01k5rslinear0000000000",
          displayName: "Linear",
          authScheme: "api_key",
          status: "connected",
        },
        ownerPublicId: null,
      },
    ]);
    expect(out.credentials.map((c) => c.server)).toEqual([
      { publicId: serverRow.publicId, name: "GitHub" },
      null,
    ]);
    expect(out.credentials[0]?.ownerPublicId).toBe(
      "usr_01k5rsmarcus0000000000",
    );
  });

  it("killSwitches: separates the deny from who flipped it", async () => {
    results.set(schema.emergencyDenies, [denyRow]);
    const [src] = await postgresToolsStore.killSwitches(SCOPE);
    const { activatedByPublicId, deactivatedByPublicId, ...deny } = denyRow;
    expect(src).toEqual({ deny, activatedByPublicId, deactivatedByPublicId });
  });
});

describe("live tools port", () => {
  it("killSwitches parses a real emergency-deny row through the KillSwitch view model", async () => {
    results.set(schema.emergencyDenies, [denyRow]);
    const res = await createLiveTools({
      store: withStore(),
      report,
    }).killSwitches(SCOPE);
    expect(res).toEqual({
      ok: true,
      value: [
        KillSwitch.parse({
          id: "emd_01k5rsdeny00000000000",
          level: "tool_version",
          target: "dispatch_tacho_command",
          on: true,
          headline: false,
          flippedById: "usr_01k5rsdana00000000000",
          flippedAt: "2026-09-11T09:14:02.000Z",
          reason: "credential probe from an unenrolled host",
          blastRadius: {
            agents: null,
            toolVersions: null,
            mandates: null,
            runsInFlight: null,
            grants24h: null,
          },
        }),
      ],
    });
    expect(report).not.toHaveBeenCalled();
  });

  it.each(["servers", "toolVersions", "connections", "killSwitches"] as const)(
    "%s with no rows is an honest empty list, not a not-backed state",
    async (method) => {
      const res = await createLiveTools({ store: withStore(), report })[method](
        SCOPE,
      );
      expect(res).toEqual({ ok: true, value: [] });
    },
  );

  describe("fields the view model cannot hold as unrecorded", () => {
    function seedAll() {
      results.set(schema.mcpServers, [serverRow]);
      results.set(schema.mcpToolSnapshots, descriptorRows);
      results.set(schema.toolVersions, [
        {
          slug: "deploy_preview",
          source: "custom",
          versionNumber: 1,
          riskGrade: "low",
          readOnly: true,
          checksum: "c".repeat(64),
        },
      ]);
      results.set(schema.sourceConnections, [
        {
          publicId: "con_01k5rslinear0000000000",
          displayName: "Linear",
          authScheme: "api_key",
          status: "connected",
          ownerPublicId: "usr_01k5rsmarcus0000000000",
        },
      ]);
      results.set(schema.mcpCredentials, [
        {
          publicId: "mcrd_a0000000000000000000",
          authKind: "oauth",
          status: "active",
          ownerPublicId: null,
          serverPublicId: serverRow.publicId,
          serverName: "GitHub",
          orgListingId: serverRow.orgListingId,
        },
      ]);
    }

    it.each(["servers", "toolVersions", "connections"] as const)(
      "%s is not backed under today's contract, never a fabricated zero",
      async (method) => {
        seedAll();
        const res = await createLiveTools({ store: withStore(), report })[
          method
        ](SCOPE);
        const { milestone, gap } = backingOf("tools", method);
        expect(res).toEqual({
          ok: false,
          reason: "not_backed",
          milestone,
          gap,
        });
        expect(report).not.toHaveBeenCalled();
      },
    );

    it("servers parses the real row once the unrecorded fields are nullable", async () => {
      seedAll();
      const res = await createLiveTools({
        store: withStore(),
        report,
        views: WIDENED,
      }).servers(SCOPE);
      expect(res).toEqual({
        ok: true,
        value: [
          {
            id: "mcs-01k5rsgithub0000000000",
            name: "GitHub",
            kind: "mcp",
            transport: "streamable_http",
            endpoint: "https://api.githubcopilot.com/mcp/",
            toolCount: 1,
            versionCount: 2,
            status: "active",
            health: "ok",
            lastImportAt: "2026-09-11T09:14:02.000Z",
            connectionId: "mcrd_a0000000000000000000",
            pendingSchemaCount: null,
          },
        ],
      });
    });

    it("toolVersions parses declared and imported rows once widened, and filters by server", async () => {
      seedAll();
      const port = createLiveTools({
        store: withStore(),
        report,
        views: WIDENED,
      });
      const all = await port.toolVersions(SCOPE);
      expect(
        all.ok && all.value.map((v) => [v.name, v.version, v.schemaOrigin]),
      ).toEqual([
        ["deploy_preview", "1", "declared"],
        ["create_pull_request", "1", "imported"],
        ["list_issues", "1", "imported"],
      ]);
      const one = await port.toolVersions(SCOPE, {
        serverId: "mcs-01k5rsgithub0000000000",
      });
      expect(one.ok && one.value.map((v) => v.name)).toEqual([
        "create_pull_request",
        "list_issues",
      ]);
    });

    it("connections parses both kinds once widened", async () => {
      seedAll();
      const res = await createLiveTools({
        store: withStore(),
        report,
        views: WIDENED,
      }).connections(SCOPE);
      expect(
        res.ok && res.value.map((c) => [c.id, c.kind, c.status, c.serverIds]),
      ).toEqual([
        ["con_01k5rslinear0000000000", "api_key", "active", []],
        [
          "mcrd_a0000000000000000000",
          "oauth",
          "active",
          ["mcs-01k5rsgithub0000000000"],
        ],
      ]);
    });
  });

  it("an organization-only scope is refused before any store read", async () => {
    const store = withStore({ killSwitches: vi.fn() });
    const res = await createLiveTools({ store, report }).killSwitches({
      orgId: SCOPE.orgId,
      workspaceId: ORG_ONLY_WORKSPACE_ID,
    });
    expect(res).toEqual({
      ok: false,
      reason: "error",
      code: WORKSPACE_SCOPE_REQUIRED,
      status: 400,
    });
    expect(store.killSwitches).not.toHaveBeenCalled();
    expect(scopesSeen).toEqual([]);
  });

  it("a store failure is the page's named error, reported, never an empty list", async () => {
    const boom = new Error("connection refused");
    const res = await createLiveTools({
      store: withStore({ servers: () => Promise.reject(boom) }),
      report,
    }).servers(SCOPE);
    expect(res).toEqual({
      ok: false,
      reason: "error",
      ...PAGE_FAILURES.tools.error,
    });
    expect(report).toHaveBeenCalledWith(boom, "tools.servers read failed");
  });

  it("a mapped value the view model rejects is a reported mismatch, not not-backed", async () => {
    results.set(schema.mcpServers, [
      { ...serverRow, discoveredTools: { corrupt: true } },
    ]);
    const res = await createLiveTools({
      store: withStore(),
      report,
      views: WIDENED,
    }).servers(SCOPE);
    expect(res).toEqual({
      ok: false,
      reason: "error",
      code: TOOL_REGISTRY_UNMAPPABLE,
      status: 500,
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(String(report.mock.calls[0]?.[0])).toContain("toolCount");
  });

  it.each([
    "observedSchemas",
    "mandateLedger",
    "policyVersions",
    "policySimulation",
    "autoApprovalRules",
    "assurance",
  ] as const)("%s names its milestone and gap", async (method) => {
    const { milestone, gap } = backingOf("tools", method);
    await expect(liveTools[method](SCOPE, "pol_1")).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone,
      gap,
    });
  });

  it("reports to the telemetry error stream, and a failing capture never throws", async () => {
    const captureError = vi.fn();
    vi.doMock("@oxagen/telemetry", () => ({ captureError }));
    const boom = new Error("read failed");
    await reportToTelemetry(boom, "tools.servers read failed");
    expect(captureError).toHaveBeenCalledWith({
      error: boom,
      source: "app",
      severity: "error",
      context: "tools.servers read failed",
    });
    captureError.mockImplementation(() => {
      throw new Error("clickhouse down");
    });
    await expect(reportToTelemetry(boom, "again")).resolves.toBeUndefined();
    vi.doUnmock("@oxagen/telemetry");
  });
});
