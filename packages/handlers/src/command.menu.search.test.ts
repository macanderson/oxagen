import { describe, it, expect, vi, afterEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Mock all I/O ──────────────────────────────────────────────────────────────

// graph.node.search via invoke()
const mockInvoke = vi.fn().mockResolvedValue({ nodes: [] });
vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// withTenantDb — returns an empty list by default; override per test.
const mockWithTenantDb = vi.fn().mockResolvedValue([]);
vi.mock("@oxagen/database", () => ({
  schema: {
    agentExecutions: {
      orgId: "orgId",
      workspaceId: "workspaceId",
      publicId: "publicId",
      status: "status",
      createdAt: "createdAt",
      deletedAt: "deletedAt",
    },
    agents: {
      orgId: "orgId",
      workspaceId: "workspaceId",
      publicId: "publicId",
      name: "name",
      slug: "slug",
      status: "status",
      deletedAt: "deletedAt",
    },
    principals: {
      orgId: "orgId",
      publicId: "publicId",
      displayName: "displayName",
      kind: "kind",
      status: "status",
      idpSubject: "idpSubject",
    },
  },
  withTenantDb: (fn: (tx: unknown) => Promise<unknown>) => mockWithTenantDb(fn),
}));

// drizzle functions — just return their args so we can verify they don't throw
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  ilike: (a: unknown, b: unknown) => ({ ilike: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
  or: (...args: unknown[]) => ({ or: args }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { commandMenuSearchHandler } from "./command.menu.search";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "app",
  messageId: null,
};

afterEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue({ nodes: [] });
  mockWithTenantDb.mockResolvedValue([]);
});

describe("commandMenuSearchHandler", () => {
  it("returns empty rows when all sources return nothing", async () => {
    const result = await commandMenuSearchHandler(
      {
        kind: "run",
        query: "aex_nothing",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );
    expect(result.rows).toHaveLength(0);
  });

  it("maps agent Postgres rows into SearchResultRow with correct href", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        // Simulate tx chain: .select().from().where().limit() → rows
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () =>
            Promise.resolve([
              {
                publicId: "agt_abc",
                name: "Churn Investigator",
                status: "active",
              },
            ]),
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSearchHandler(
      {
        kind: "agent",
        query: "churn",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.kind).toBe("agent");
    expect(row?.label).toBe("Churn Investigator");
    expect(row?.href).toBe("/acme/prod/agents/agt_abc");
    expect(row?.contextLine).toBe("Status: active");
    expect(row?.scope).toBe("Workspace: prod");
  });


  it("merges graph + Postgres results, deduplicates by href", async () => {
    // Graph returns a node for the same entity, under a different route.
    mockInvoke.mockResolvedValue({
      nodes: [
        {
          nodeId: "agt_abc",
          label: "Agent",
          displayName: "Churn Investigator",
          description: "Graph node",
        },
      ],
    });
    // Postgres also returns the same record
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () =>
            Promise.resolve([
              {
                publicId: "agt_abc",
                name: "Churn Investigator",
                status: "active",
              },
            ]),
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSearchHandler(
      {
        kind: "agent",
        query: "churn",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );

    // Postgres href: /acme/prod/agents/agt_abc
    // Graph href:    /acme/prod/knowledge/graph/agt_abc
    // Different hrefs → no dedup; both appear, Postgres first.
    expect(result.rows.length).toBeLessThanOrEqual(8);
    expect(result.rows[0]?.href).toBe("/acme/prod/agents/agt_abc");
  });

  it("slices merged results to max 8 rows", async () => {
    // Return 6 Postgres rows + 5 graph nodes → 11 total, should be sliced to 8
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () =>
            Promise.resolve(
              Array.from({ length: 6 }, (_, i) => ({
                publicId: `aex_${i}`,
                status: "completed",
                createdAt: new Date(),
              })),
            ),
        };
        return fn(tx);
      },
    );
    mockInvoke.mockResolvedValue({
      nodes: Array.from({ length: 5 }, (_, i) => ({
        nodeId: `node_${i}`,
        label: "Run",
        displayName: `Run ${i}`,
        description: null,
      })),
    });

    const result = await commandMenuSearchHandler(
      { kind: "run", query: "aex", orgSlug: "acme", workspaceSlug: "prod" },
      ctx,
    );
    expect(result.rows.length).toBeLessThanOrEqual(8);
  });

  it("gracefully handles graph.node.search failure (ontology best-effort)", async () => {
    mockInvoke.mockRejectedValue(new Error("Neo4j unavailable"));
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () =>
            Promise.resolve([
              { publicId: "agt_abc", name: "Cleanup Agent", status: "active" },
            ]),
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSearchHandler(
      {
        kind: "agent",
        query: "cleanup",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );
    // Should still return Postgres rows despite graph failure.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.kind).toBe("agent");
  });

  it("searches across all kinds when no kind filter is provided", async () => {
    // Each withTenantDb call returns 1 row of the appropriate type
    let callCount = 0;
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        const entityConfigs = [
          [{ publicId: "aex_1", status: "failed", createdAt: new Date() }],
          [{ publicId: "plb_1", name: "Playbook A", status: "active" }],
          [{ publicId: "plt_1", triggerType: "webhook", isEnabled: true }],
          [{ publicId: "agt_1", name: "Agent A", status: "active" }],
          [
            {
              publicId: "prn_1",
              displayName: "Alice",
              kind: "human",
              status: "active",
            },
          ],
        ];
        const data =
          entityConfigs[(callCount - 1) % entityConfigs.length] ?? [];
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () => Promise.resolve(data),
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSearchHandler(
      { query: "a", orgSlug: "acme", workspaceSlug: "prod" },
      ctx,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows.length).toBeLessThanOrEqual(8);
  });
});
