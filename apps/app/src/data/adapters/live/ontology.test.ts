import type { schema } from "@oxagen/database";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import type { ConnectionMappingsGetOutput } from "@oxagen/oxagen/contracts/connection.mappings.get";
import { getScope } from "@oxagen/tenancy";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BACKING } from "@/data/backing";
import { NO_GAP } from "@/data/not-backed";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(
      readonly capability: string,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "CapabilityError";
    }
  }
  return {
    CapabilityError,
    registry: { loaded: 0 },
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
    withTenantDb: vi.fn<(fn: (tx: unknown) => unknown) => Promise<unknown>>(),
  };
});

vi.mock("@oxagen/handlers/register", () => {
  mocks.registry.loaded += 1;
  return {};
});
vi.mock("@oxagen/oxagen", () => ({
  CapabilityError: mocks.CapabilityError,
  invoke: mocks.invoke,
  getCapability: mocks.getCapability,
}));
vi.mock("@/server/session", () => ({ getSession: mocks.getSession }));
vi.mock("@oxagen/database", () => ({
  schema: {
    sourceConnections: {
      id: "source_connections.id",
      cursor: "source_connections.cursor",
      orgId: "source_connections.org_id",
      workspaceId: "source_connections.workspace_id",
      deletedAt: "source_connections.deleted_at",
    },
  },
  withTenantDb: mocks.withTenantDb,
}));
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  isNull: (column: unknown) => ({ isNull: column }),
}));

import {
  createLiveOntology,
  isCapabilityDenial,
  liveOntology,
  liveOntologyDeps,
  type OntologyLiveDeps,
} from "./ontology";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-00000000c0de",
};
const USER = "0192d4a8-7c1e-7a00-8000-0000000000ab";
const GITHUB_ID = "0192d4a8-7c1e-7a00-8000-0000000c0001";
const LINEAR_ID = "0192d4a8-7c1e-7a00-8000-0000000c0002";
const GITHUB_PUBLIC = "con_01K5RSGH7Q";
const LINEAR_PUBLIC = "con_01K5RSLN2B";

type Connection = ConnectionListOutput["connections"][number];

function connection(overrides: Partial<Connection>): Connection {
  return {
    id: GITHUB_ID,
    publicId: GITHUB_PUBLIC,
    connectorId: "github",
    displayName: "GitHub · acme/platform",
    authScheme: "github_app",
    deliveryMethod: "webhook",
    status: "connected",
    entityCount: 184022,
    lastSyncAt: "2026-09-11T07:31:04.120Z",
    healthStatus: "healthy",
    lastPollAt: "2026-09-11T07:31:00.000Z",
    nextPollAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

const MAPPINGS: Record<string, ConnectionMappingsGetOutput["mappings"]> = {
  [GITHUB_PUBLIC]: [
    {
      id: "etm-1",
      sourceRecordType: "pull_request",
      oxagenEntityType: "PullRequest",
      propertyMappings: {},
      isActive: true,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    },
  ],
  [LINEAR_PUBLIC]: [],
};

type Call = { contract: string; input: unknown; userId: string };

/** Fake I/O: records every capability call and answers from the tables above. */
function fakeDeps(
  connections: Connection[],
  overrides?: Partial<OntologyLiveDeps>,
) {
  const calls: Call[] = [];
  const deps: OntologyLiveDeps = {
    principal: () => Promise.resolve(USER),
    invoke: <I, O>(call: {
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
      if (call.contract.name === "list_connections")
        return Promise.resolve({ connections } as O);
      const { connectionId } = call.input as { connectionId: string };
      return Promise.resolve({ mappings: MAPPINGS[connectionId] ?? [] } as O);
    },
    connectionCursors: () =>
      Promise.resolve([
        { id: GITHUB_ID, cursor: { issue: "2026-09-11T07:29:00Z" } },
      ]),
    ...overrides,
  };
  return { deps, calls };
}

describe("liveOntology.sources", () => {
  it("lists live GitHub and Linear sources through the kernel, parsed as Source", async () => {
    const { deps, calls } = fakeDeps([
      connection({}),
      connection({
        id: LINEAR_ID,
        publicId: LINEAR_PUBLIC,
        connectorId: "linear",
        displayName: "Linear · Platform",
        status: "paused",
        healthStatus: "degraded",
        entityCount: 0,
      }),
      connection({ id: "slack", connectorId: "slack" }),
      connection({ id: "setup", status: "pending_setup", lastSyncAt: null }),
    ]);
    await expect(createLiveOntology(deps).sources(SCOPE)).resolves.toEqual({
      ok: true,
      value: [
        {
          name: "GitHub · acme/platform",
          kind: "github",
          records: 184022,
          lastSyncAt: "2026-09-11T07:31:04.120Z",
          health: "ok",
          cursor: "issue 2026-09-11T07:29:00Z",
          entities: ["PullRequest"],
        },
        {
          name: "Linear · Platform",
          kind: "linear",
          records: 0,
          lastSyncAt: "2026-09-11T07:31:04.120Z",
          health: "degraded",
          cursor: "",
          entities: [],
        },
      ],
    });
    // Mappings are read only for the listed sources, by public id (the handler
    // matches nothing else), always as the viewer.
    expect(calls).toEqual([
      { contract: "list_connections", input: {}, userId: USER },
      {
        contract: "get_connection_mappings",
        input: { connectionId: GITHUB_PUBLIC },
        userId: USER,
      },
      {
        contract: "get_connection_mappings",
        input: { connectionId: LINEAR_PUBLIC },
        userId: USER,
      },
    ]);
  });

  it("is empty, not not-backed, for a workspace with no sources", async () => {
    const { deps } = fakeDeps([connection({ connectorId: "google-drive" })]);
    await expect(createLiveOntology(deps).sources(SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
  });

  it("says not recorded rather than invent a sync time for a never-synced source (negative)", async () => {
    const { deps } = fakeDeps([
      connection({}),
      connection({ id: LINEAR_ID, connectorId: "linear", lastSyncAt: null }),
    ]);
    await expect(createLiveOntology(deps).sources(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M0",
      gap: NO_GAP,
    });
  });

  it("refuses an organization-level scope: sources belong to a workspace (negative)", async () => {
    const { deps, calls } = fakeDeps([connection({})]);
    await expect(
      createLiveOntology(deps).sources({
        orgId: SCOPE.orgId,
        workspaceId: ORG_ONLY_WORKSPACE_ID,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "workspace_scope_required",
      status: 400,
    });
    expect(calls).toEqual([]);
  });

  it("is denied without a signed-in person, and never reaches the kernel (negative)", async () => {
    const { deps, calls } = fakeDeps([connection({})], {
      principal: () => Promise.resolve(null),
    });
    await expect(createLiveOntology(deps).sources(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "denied",
      permission: "graph.read",
    });
    expect(calls).toEqual([]);
  });

  it.each([
    "authz_denied",
    "pending_approval",
    "surface_denied",
    "capability_not_installed",
  ])("turns a kernel %s into a denied read (negative)", async (code) => {
    const { deps } = fakeDeps([], {
      invoke: () =>
        Promise.reject(
          new mocks.CapabilityError("list_connections", code, "no"),
        ),
    });
    await expect(createLiveOntology(deps).sources(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "denied",
      permission: "graph.read",
    });
  });

  it("rethrows a store failure for the page's error boundary, never a value (negative)", async () => {
    const failure = new Error("connect ECONNREFUSED 127.0.0.1:5433");
    const { deps } = fakeDeps([connection({})], {
      connectionCursors: () => Promise.reject(failure),
    });
    await expect(createLiveOntology(deps).sources(SCOPE)).rejects.toBe(failure);
  });

  it("rethrows a kernel error that is not a denial (negative)", async () => {
    const failure = new mocks.CapabilityError(
      "list_connections",
      "invalid_output",
      "bad",
    );
    const { deps } = fakeDeps([], { invoke: () => Promise.reject(failure) });
    await expect(createLiveOntology(deps).sources(SCOPE)).rejects.toBe(failure);
  });
});

describe("isCapabilityDenial", () => {
  it("does not treat a plain error or a non-denial code as a denial (negative)", () => {
    expect(isCapabilityDenial(new Error("authz_denied"))).toBe(false);
    expect(
      isCapabilityDenial(new mocks.CapabilityError("x", "no_handler", "")),
    ).toBe(false);
    expect(isCapabilityDenial({ code: "authz_denied" })).toBe(false);
  });
});

describe("liveOntology: methods with no honest mapping today", () => {
  it.each(["classes", "repositories", "versions", "embeddingIndexes"] as const)(
    "%s returns its backing milestone and gap, never a value",
    async (method) => {
      const { milestone, gap } = BACKING.ontology[method];
      await expect(liveOntology[method](SCOPE)).resolves.toEqual({
        ok: false,
        reason: "not_backed",
        milestone,
        gap,
      });
    },
  );

  it("names M4 for repositories and versions, not a store that exists (A5 column check)", () => {
    expect(BACKING.ontology.repositories).toMatchObject({ milestone: "M4" });
    expect(BACKING.ontology.versions).toMatchObject({ milestone: "M4" });
    expect(BACKING.ontology.embeddingIndexes).toMatchObject({
      milestone: "M4",
    });
  });
});

describe("liveOntologyDeps (production I/O)", () => {
  const contract = {
    name: "list_connections",
    input: z.object({}),
    output: z.object({ connections: z.array(z.object({ id: z.string() })) }),
  };

  it("reads the principal from the request session", async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: USER } });
    await expect(liveOntologyDeps.principal()).resolves.toBe(USER);
    mocks.getSession.mockResolvedValueOnce(null);
    await expect(liveOntologyDeps.principal()).resolves.toBeNull();
  });

  it("invokes as the viewer inside the tenant scope, loads handlers once, and parses the output", async () => {
    mocks.getCapability.mockReturnValue({ name: "list_connections" });
    let scopeSeen: unknown = null;
    mocks.invoke.mockImplementation(() => {
      scopeSeen = getScope();
      return Promise.resolve({ connections: [{ id: "c1" }] });
    });
    const call = { scope: SCOPE, userId: USER, contract, input: {} };
    await expect(liveOntologyDeps.invoke(call)).resolves.toEqual({
      connections: [{ id: "c1" }],
    });
    await liveOntologyDeps.invoke(call);
    // Two invokes, one handler-registry import.
    expect(mocks.registry.loaded).toBe(1);
    expect(scopeSeen).toMatchObject(SCOPE);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_connections",
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
  });

  it("throws ToolNotRegistered for a contract the kernel does not know (negative)", async () => {
    mocks.getCapability.mockReturnValue(undefined);
    await expect(
      liveOntologyDeps.invoke({
        scope: SCOPE,
        userId: USER,
        contract,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ToolNotRegistered);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("throws ContractOutputMismatch rather than pass an unparsed result on (negative)", async () => {
    mocks.getCapability.mockReturnValue({ name: "list_connections" });
    mocks.invoke.mockResolvedValue({ connections: "not a list" });
    await expect(
      liveOntologyDeps.invoke({
        scope: SCOPE,
        userId: USER,
        contract,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ContractOutputMismatch);
  });

  it("reads cursors through withTenantDb for the scope's org and workspace, deleted rows excluded", async () => {
    const rows: Array<
      Pick<typeof schema.sourceConnections.$inferSelect, "id" | "cursor">
    > = [{ id: GITHUB_ID, cursor: { issue: "2026-09-11T07:29:00Z" } }];
    const seen: {
      select?: unknown;
      from?: unknown;
      where?: unknown;
      scope?: unknown;
    } = {};
    mocks.withTenantDb.mockImplementation((fn) => {
      seen.scope = getScope();
      const tx = {
        select: (columns: unknown) => {
          seen.select = columns;
          return {
            from: (table: unknown) => {
              seen.from = table;
              return {
                where: (clause: unknown) => {
                  seen.where = clause;
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
      return Promise.resolve(fn(tx));
    });
    await expect(liveOntologyDeps.connectionCursors(SCOPE)).resolves.toBe(rows);
    expect(seen.scope).toMatchObject(SCOPE);
    expect(seen.select).toEqual({
      id: "source_connections.id",
      cursor: "source_connections.cursor",
    });
    expect(seen.where).toEqual({
      and: [
        { eq: ["source_connections.org_id", SCOPE.orgId] },
        { eq: ["source_connections.workspace_id", SCOPE.workspaceId] },
        { isNull: "source_connections.deleted_at" },
      ],
    });
  });

  it("refuses to read cursors outside a valid tenant scope (negative)", () => {
    expect(() =>
      liveOntologyDeps.connectionCursors({ orgId: "", workspaceId: "" }),
    ).toThrow();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
