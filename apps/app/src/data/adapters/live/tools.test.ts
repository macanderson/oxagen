import type { CapabilityErrorCode } from "@oxagen/oxagen";
import { requireScope } from "@oxagen/tenancy";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
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
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";
import type { ServerSource } from "./mappers/tools";

const kernel = vi.hoisted(() => ({
  invoke:
    vi.fn<
      (
        name: string,
        input: unknown,
        ctx: Record<string, unknown>,
      ) => Promise<unknown>
    >(),
  getCapability: vi.fn<(name: string) => unknown>(),
  getSession: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
  registered: { handlers: 0, agent: 0 },
}));

vi.mock("@oxagen/handlers/register", () => {
  kernel.registered.handlers += 1;
  return {};
});
vi.mock("@oxagen/agent/register", () => {
  kernel.registered.agent += 1;
  return {};
});
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke: kernel.invoke,
  getCapability: kernel.getCapability,
}));
vi.mock("@/server/session", () => ({ getSession: kernel.getSession }));

// The fake transaction answers each `select … from(<table>)` with the rows the
// test registered for that table, records that it ran inside tenant scope, and
// keeps every where/join condition so a test can read the ids a query matches.
type Rows = Record<string, unknown>[];
const results = new Map<unknown, Rows>();
const scopesSeen: Array<{ orgId: string; workspaceId: string }> = [];
const conditions = new Map<unknown, SQL[]>();

function builder() {
  let table: unknown;
  const keep = (cond: SQL) => {
    conditions.set(table, [...(conditions.get(table) ?? []), cond]);
  };
  const b = {
    from(t: unknown) {
      table = t;
      return b;
    },
    innerJoin: (_t: unknown, cond: SQL) => {
      keep(cond);
      return b;
    },
    leftJoin: (_t: unknown, cond: SQL) => {
      keep(cond);
      return b;
    },
    where: (cond: SQL) => {
      keep(cond);
      return b;
    },
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
const { CapabilityError } = await import("@oxagen/oxagen");
const { agentMcpList } = await import(
  "@oxagen/oxagen/contracts/agent.mcp.list"
);
const {
  TOOL_REGISTRY_UNMAPPABLE,
  WORKSPACE_SCOPE_REQUIRED,
  createLiveTools,
  isCapabilityDenial,
  liveTools,
  liveToolsDeps,
  postgresToolsStore,
  reportToTelemetry,
} = await import("./tools");
type LiveToolsDeps = import("./tools").LiveToolsDeps;
type InvokeRead = import("./tools").InvokeRead;

const dialect = new PgDialect();
/** Every bound parameter and SQL fragment of the queries run against `table`. */
function queryOf(table: unknown): { sql: string; params: unknown[] } {
  const parts = (conditions.get(table) ?? []).map((c) => dialect.sqlToQuery(c));
  return {
    sql: parts.map((p) => p.sql).join(" "),
    params: parts.flatMap((p) => p.params),
  };
}

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const USER = "0192d4a8-7c1e-7a00-8000-0000000000ab";
const T0 = new Date("2026-09-10T08:00:00.000Z");
const T1 = new Date("2026-09-11T09:14:02.000Z");
const TOOL_PUBLIC = "tol_01k5rsdeploy0000000000";
const CONNECTION_PUBLIC = "con_01k5rslinear0000000000";

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

const SERVER_GRANT = { serverPublicIds: [serverRow.publicId] };

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
} as unknown as NonNullable<LiveToolsDeps["views"]>;

beforeEach(() => {
  results.clear();
  conditions.clear();
  scopesSeen.length = 0;
});

const report = vi.fn();

function withStore(overrides: Partial<typeof postgresToolsStore> = {}) {
  return { ...postgresToolsStore, ...overrides };
}

/** A store whose every method is a spy over the fake-transaction store. */
function spiedStore() {
  return {
    servers: vi.fn(postgresToolsStore.servers),
    toolVersions: vi.fn(postgresToolsStore.toolVersions),
    connections: vi.fn(postgresToolsStore.connections),
    killSwitches: vi.fn(postgresToolsStore.killSwitches),
  };
}

type KernelScript = {
  servers?: string[];
  tools?: string[];
  connections?: string[];
  /** Capability name → the error its call rejects with. */
  fail?: Partial<Record<string, unknown>>;
};

type Call = { contract: string; input: unknown; userId: string };

/** A fake kernel: records every capability call and answers from the script. */
function fakeKernel(script: KernelScript = {}) {
  const calls: Call[] = [];
  const answer = (name: string, input: unknown): unknown => {
    switch (name) {
      case "list_mcp_servers":
        return {
          servers: (script.servers ?? [serverRow.publicId]).map((publicId) => ({
            publicId,
          })),
        };
      case "list_tool_declarations": {
        const all = script.tools ?? [TOOL_PUBLIC];
        const { limit, offset } = input as { limit: number; offset: number };
        return {
          tools: all.slice(offset, offset + limit).map((id) => ({ id })),
          total: all.length,
        };
      }
      case "list_connections":
        return {
          connections: (script.connections ?? [CONNECTION_PUBLIC]).map(
            (publicId) => ({ publicId }),
          ),
        };
      case "list_iam_roles":
        return { roles: [], total: 0, hasMore: false, limit: 1, offset: 0 };
      default:
        throw new Error(`unexpected capability ${name}`);
    }
  };
  const invoke: InvokeRead = <I, O>(call: {
    scope: typeof SCOPE;
    userId: string;
    contract: ToolContract<I, O>;
    input: I;
  }) => {
    const name = call.contract.name;
    calls.push({ contract: name, input: call.input, userId: call.userId });
    if (script.fail && name in script.fail)
      return Promise.reject(script.fail[name]);
    return Promise.resolve(answer(name, call.input) as O);
  };
  return { invoke, calls };
}

function port(overrides: Partial<LiveToolsDeps> = {}) {
  return createLiveTools({
    principal: () => Promise.resolve(USER),
    invoke: fakeKernel().invoke,
    store: withStore(),
    report,
    ...overrides,
  });
}

const denial = (capability: string, code: CapabilityErrorCode) =>
  new CapabilityError(capability, code, `${code} for ${capability}`);

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
    await expect(
      postgresToolsStore.servers(SCOPE, SERVER_GRANT),
    ).resolves.toEqual<ServerSource[]>([
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
    const [src] = await postgresToolsStore.servers(SCOPE, SERVER_GRANT);
    expect(src?.credentialPublicId).toBeNull();
    expect(src?.snapshots).toEqual({
      descriptorCount: 0,
      lastCapturedAt: null,
    });
  });

  it("servers: the server and snapshot queries match only the granted public ids", async () => {
    await postgresToolsStore.servers(SCOPE, {
      serverPublicIds: [serverRow.publicId, "mcs_second0000000000000"],
    });
    for (const table of [schema.mcpServers, schema.mcpToolSnapshots]) {
      const { sql, params } = queryOf(table);
      expect(sql).toContain('"public_id" in');
      expect(params).toEqual(
        expect.arrayContaining([serverRow.publicId, "mcs_second0000000000000"]),
      );
    }
  });

  it("an empty grant matches no server, tool or connection row", async () => {
    const empty = {
      serverPublicIds: [],
      toolPublicIds: [],
      connectionPublicIds: [],
    };
    await postgresToolsStore.servers(SCOPE, empty);
    await postgresToolsStore.toolVersions(SCOPE, empty);
    await postgresToolsStore.connections(SCOPE, empty);
    for (const table of [
      schema.mcpServers,
      schema.mcpToolSnapshots,
      schema.toolVersions,
      schema.sourceConnections,
      schema.mcpCredentials,
    ]) {
      expect(queryOf(table).sql).toContain("false");
    }
  });

  it("toolVersions: splits declared rows into tool and version, keeps first captures, and matches only granted ids", async () => {
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
    const out = await postgresToolsStore.toolVersions(SCOPE, {
      ...SERVER_GRANT,
      toolPublicIds: [TOOL_PUBLIC],
    });
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
    expect(queryOf(schema.toolVersions).params).toContain(TOOL_PUBLIC);
    expect(queryOf(schema.mcpToolSnapshots).params).toContain(
      serverRow.publicId,
    );
    expect(scopesSeen).toEqual([SCOPE]);
  });

  it("connections: attaches owners and the granted server a credential backs", async () => {
    results.set(schema.sourceConnections, [
      {
        publicId: CONNECTION_PUBLIC,
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
    const out = await postgresToolsStore.connections(SCOPE, {
      ...SERVER_GRANT,
      connectionPublicIds: [CONNECTION_PUBLIC],
    });
    expect(out.sources).toEqual([
      {
        connection: {
          publicId: CONNECTION_PUBLIC,
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
    expect(queryOf(schema.sourceConnections).params).toContain(
      CONNECTION_PUBLIC,
    );
    expect(queryOf(schema.mcpCredentials).params).toContain(serverRow.publicId);
  });

  it("killSwitches: separates the deny from who flipped it", async () => {
    results.set(schema.emergencyDenies, [denyRow]);
    const [src] = await postgresToolsStore.killSwitches(SCOPE);
    const { activatedByPublicId, deactivatedByPublicId, ...deny } = denyRow;
    expect(src).toEqual({ deny, activatedByPublicId, deactivatedByPublicId });
  });
});

describe("live tools port", () => {
  it("killSwitches decides through list_iam_roles, then parses a real emergency-deny row through KillSwitch", async () => {
    results.set(schema.emergencyDenies, [denyRow]);
    const { invoke, calls } = fakeKernel();
    const res = await port({ invoke }).killSwitches(SCOPE);
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
    expect(calls).toEqual([
      {
        contract: "list_iam_roles",
        input: { includeGrants: false, limit: 1 },
        userId: USER,
      },
    ]);
    expect(report).not.toHaveBeenCalled();
  });

  it.each(["servers", "toolVersions", "connections", "killSwitches"] as const)(
    "%s with no rows is an honest empty list, not a not-backed state",
    async (method) => {
      const { invoke } = fakeKernel({
        servers: [],
        tools: [],
        connections: [],
      });
      const res = await port({ invoke })[method](SCOPE);
      expect(res).toEqual({ ok: true, value: [] });
    },
  );

  describe("the store reads only what the capabilities returned", () => {
    it("servers passes list_mcp_servers' public ids", async () => {
      const store = spiedStore();
      const { invoke, calls } = fakeKernel({
        servers: [serverRow.publicId, "mcs_second0000000000000"],
      });
      await port({ store, invoke }).servers(SCOPE);
      expect(calls).toEqual([
        { contract: "list_mcp_servers", input: {}, userId: USER },
      ]);
      expect(store.servers).toHaveBeenCalledWith(SCOPE, {
        serverPublicIds: [serverRow.publicId, "mcs_second0000000000000"],
      });
    });

    it("toolVersions pages through every declaration and passes the servers too", async () => {
      const store = spiedStore();
      const tools = Array.from({ length: 201 }, (_, i) => `tol_${i}`);
      const { invoke, calls } = fakeKernel({ tools });
      await port({ store, invoke }).toolVersions(SCOPE);
      expect(
        calls
          .filter((c) => c.contract === "list_tool_declarations")
          .map((c) => c.input),
      ).toEqual([
        { limit: 200, offset: 0 },
        { limit: 200, offset: 200 },
      ]);
      expect(store.toolVersions).toHaveBeenCalledWith(SCOPE, {
        serverPublicIds: [serverRow.publicId],
        toolPublicIds: tools,
      });
    });

    it("toolVersions stops paging on an empty page even if the total says more", async () => {
      const { calls } = fakeKernel();
      const invoke: InvokeRead = <I, O>(call: {
        scope: typeof SCOPE;
        userId: string;
        contract: ToolContract<I, O>;
        input: I;
      }) => {
        calls.push({
          contract: call.contract.name,
          input: call.input,
          userId: call.userId,
        });
        return Promise.resolve(
          (call.contract.name === "list_tool_declarations"
            ? { tools: [], total: 5 }
            : { servers: [] }) as O,
        );
      };
      const store = spiedStore();
      await port({ store, invoke }).toolVersions(SCOPE);
      expect(
        calls.filter((c) => c.contract === "list_tool_declarations"),
      ).toHaveLength(1);
      expect(store.toolVersions).toHaveBeenCalledWith(SCOPE, {
        serverPublicIds: [],
        toolPublicIds: [],
      });
    });

    it("connections passes list_connections' and list_mcp_servers' public ids", async () => {
      const store = spiedStore();
      const { invoke } = fakeKernel();
      await port({ store, invoke }).connections(SCOPE);
      expect(store.connections).toHaveBeenCalledWith(SCOPE, {
        serverPublicIds: [serverRow.publicId],
        connectionPublicIds: [CONNECTION_PUBLIC],
      });
    });
  });

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
          publicId: CONNECTION_PUBLIC,
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
        const res = await port()[method](SCOPE);
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
      const res = await port({ views: WIDENED }).servers(SCOPE);
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
      const tools = port({ views: WIDENED });
      const all = await tools.toolVersions(SCOPE);
      expect(
        all.ok && all.value.map((v) => [v.name, v.version, v.schemaOrigin]),
      ).toEqual([
        ["deploy_preview", "1", "declared"],
        ["create_pull_request", "1", "imported"],
        ["list_issues", "1", "imported"],
      ]);
      const one = await tools.toolVersions(SCOPE, {
        serverId: "mcs-01k5rsgithub0000000000",
      });
      expect(one.ok && one.value.map((v) => v.name)).toEqual([
        "create_pull_request",
        "list_issues",
      ]);
    });

    it("connections parses both kinds once widened", async () => {
      seedAll();
      const res = await port({ views: WIDENED }).connections(SCOPE);
      expect(
        res.ok && res.value.map((c) => [c.id, c.kind, c.status, c.serverIds]),
      ).toEqual([
        [CONNECTION_PUBLIC, "api_key", "active", []],
        [
          "mcrd_a0000000000000000000",
          "oauth",
          "active",
          ["mcs-01k5rsgithub0000000000"],
        ],
      ]);
    });
  });

  describe("IAM decides before any store read", () => {
    const WIRED = [
      "servers",
      "toolVersions",
      "connections",
      "killSwitches",
    ] as const;

    it.each(WIRED)(
      "%s without a session is denied, and neither the kernel nor the store is reached",
      async (method) => {
        const store = spiedStore();
        const { invoke, calls } = fakeKernel();
        const res = await port({
          principal: () => Promise.resolve(null),
          invoke,
          store,
        })[method](SCOPE);
        expect(res).toEqual({
          ok: false,
          reason: "denied",
          permission: PAGE_FAILURES.tools.permission,
        });
        expect(calls).toEqual([]);
        expect(store[method]).not.toHaveBeenCalled();
        expect(scopesSeen).toEqual([]);
      },
    );

    const GATES = [
      ["servers", "list_mcp_servers"],
      ["toolVersions", "list_tool_declarations"],
      ["toolVersions", "list_mcp_servers"],
      ["connections", "list_connections"],
      ["connections", "list_mcp_servers"],
      ["killSwitches", "list_iam_roles"],
    ] as const;
    const CODES = [
      "authz_denied",
      "pending_approval",
      "surface_denied",
      "capability_not_installed",
    ] as const;

    it.each(
      GATES.flatMap(([method, capability]) =>
        CODES.map((code) => ({ method, capability, code })),
      ),
    )(
      "$method: $code on $capability is denied(tools.read) and the store is never reached",
      async ({ method, capability, code }) => {
        const store = spiedStore();
        const { invoke } = fakeKernel({
          fail: { [capability]: denial(capability, code) },
        });
        const res = await port({ invoke, store })[method](SCOPE);
        expect(res).toEqual({
          ok: false,
          reason: "denied",
          permission: "tools.read",
        });
        expect(store[method]).not.toHaveBeenCalled();
        expect(scopesSeen).toEqual([]);
        expect(report).not.toHaveBeenCalled();
      },
    );

    it("a denial wins over a concurrent capability failure, and is not reported as an outage", async () => {
      const store = spiedStore();
      const { invoke } = fakeKernel({
        fail: {
          list_connections: new Error("handler lost its connection"),
          list_mcp_servers: denial("list_mcp_servers", "authz_denied"),
        },
      });
      const res = await port({ invoke, store }).connections(SCOPE);
      expect(res).toEqual({
        ok: false,
        reason: "denied",
        permission: "tools.read",
      });
      expect(store.connections).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    });

    it("a capability whose own contract rejects a stored value is a reported mismatch; the store is not reached", async () => {
      const store = spiedStore();
      const rejected = new CapabilityError(
        "list_mcp_servers",
        "invalid_output",
        "healthStatus: unknown",
      );
      const { invoke } = fakeKernel({ fail: { list_mcp_servers: rejected } });
      const res = await port({ invoke, store }).servers(SCOPE);
      expect(res).toEqual({
        ok: false,
        reason: "error",
        code: TOOL_REGISTRY_UNMAPPABLE,
        status: 500,
      });
      expect(report).toHaveBeenCalledWith(
        rejected,
        "tools.servers capability output rejected",
      );
      expect(store.servers).not.toHaveBeenCalled();
    });

    it.each([
      ["a handler failure", new Error("connection refused")],
      [
        "a missing handler",
        new CapabilityError("list_iam_roles", "no_handler", "no handler"),
      ],
    ])(
      "%s in the capability is the page's named error, reported, and the store is not reached",
      async (_label, failure) => {
        const store = spiedStore();
        const { invoke } = fakeKernel({ fail: { list_iam_roles: failure } });
        const res = await port({ invoke, store }).killSwitches(SCOPE);
        expect(res).toEqual({
          ok: false,
          reason: "error",
          ...PAGE_FAILURES.tools.error,
        });
        expect(report).toHaveBeenCalledWith(
          failure,
          "tools.killSwitches read failed",
        );
        expect(store.killSwitches).not.toHaveBeenCalled();
      },
    );

    it("a failed session read is the page's named error, reported", async () => {
      const boom = new Error("auth store down");
      const store = spiedStore();
      const res = await port({
        principal: () => Promise.reject(boom),
        store,
      }).servers(SCOPE);
      expect(res).toEqual({
        ok: false,
        reason: "error",
        ...PAGE_FAILURES.tools.error,
      });
      expect(report).toHaveBeenCalledWith(boom, "tools.servers read failed");
      expect(store.servers).not.toHaveBeenCalled();
    });

    it("isCapabilityDenial recognizes only the four denial codes on a CapabilityError", () => {
      for (const code of CODES)
        expect(isCapabilityDenial(denial("x", code))).toBe(true);
      expect(isCapabilityDenial(denial("x", "invalid_output"))).toBe(false);
      expect(isCapabilityDenial(new Error("authz_denied"))).toBe(false);
    });
  });

  it("an organization-only scope is refused before the session, the kernel or the store", async () => {
    const store = spiedStore();
    const principal = vi.fn(() => Promise.resolve(USER));
    const { invoke, calls } = fakeKernel();
    const res = await port({ principal, invoke, store }).killSwitches({
      orgId: SCOPE.orgId,
      workspaceId: ORG_ONLY_WORKSPACE_ID,
    });
    expect(res).toEqual({
      ok: false,
      reason: "error",
      code: WORKSPACE_SCOPE_REQUIRED,
      status: 400,
    });
    expect(principal).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(store.killSwitches).not.toHaveBeenCalled();
    expect(scopesSeen).toEqual([]);
  });

  it("a store failure is the page's named error, reported, never an empty list", async () => {
    const boom = new Error("connection refused");
    const res = await port({
      store: withStore({ servers: () => Promise.reject(boom) }),
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
    const res = await port({ views: WIDENED }).servers(SCOPE);
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

describe("liveToolsDeps (the production I/O)", () => {
  it("the principal is the session user, and null without a session", async () => {
    kernel.getSession.mockResolvedValueOnce({ user: { id: USER } });
    await expect(liveToolsDeps.principal()).resolves.toBe(USER);
    kernel.getSession.mockResolvedValueOnce(null);
    await expect(liveToolsDeps.principal()).resolves.toBeNull();
  });

  it("liveTools without a session is denied before any kernel call", async () => {
    kernel.getSession.mockResolvedValueOnce(null);
    await expect(liveTools.servers(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "denied",
      permission: "tools.read",
    });
    expect(kernel.invoke).not.toHaveBeenCalled();
  });

  it("invokes as the viewer on the app surface inside the tenant scope, after both handler registries load, and parses the output", async () => {
    kernel.getCapability.mockReturnValue({ name: "list_mcp_servers" });
    let scopeInside: unknown = null;
    kernel.invoke.mockImplementationOnce(() => {
      scopeInside = requireScope();
      return Promise.resolve({ servers: [] });
    });
    await expect(
      liveToolsDeps.invoke({
        scope: SCOPE,
        userId: USER,
        contract: agentMcpList,
        input: {},
      }),
    ).resolves.toEqual({ servers: [] });
    expect(kernel.invoke).toHaveBeenCalledWith(
      "list_mcp_servers",
      {},
      expect.objectContaining({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        userId: USER,
        apiKeyId: null,
        surface: "app",
        messageId: null,
      }),
    );
    expect(scopeInside).toMatchObject(SCOPE);
    expect(kernel.registered).toEqual({ handlers: 1, agent: 1 });
  });

  it("an unregistered capability is ToolNotRegistered and the kernel is not called", async () => {
    kernel.getCapability.mockReturnValue(undefined);
    await expect(
      liveToolsDeps.invoke({
        scope: SCOPE,
        userId: USER,
        contract: agentMcpList,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ToolNotRegistered);
    expect(kernel.invoke).not.toHaveBeenCalled();
  });

  it("an output the contract rejects is ContractOutputMismatch", async () => {
    kernel.getCapability.mockReturnValue({ name: "list_mcp_servers" });
    kernel.invoke.mockResolvedValueOnce({ servers: "not a list" });
    await expect(
      liveToolsDeps.invoke({
        scope: SCOPE,
        userId: USER,
        contract: agentMcpList,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ContractOutputMismatch);
  });
});
