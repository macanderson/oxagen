/**
 * actions.test.ts — unit tests for Knowledge → Graph's server actions.
 *
 * Covers, per action: happy path (exact capability `name`, input, and
 * `{ surface }` passed to invoke(), plus the mapped `{ ok: true, ... }`
 * result), the workspace-member denial path (invoke never called), and the
 * invoke-throws path (`{ ok: false, error }`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  dbState,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockWithTenantDb: vi.fn(),
  mockInvoke: vi.fn(),
  dbState: { role: "owner" as string },
}));

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/database", () => ({
  withTenantDb: mockWithTenantDb,
  schema: { workspaceUsers: { role: {}, workspaceId: {}, userId: {} } },
}));

import {
  listNodesAction,
  searchNodesAction,
  semanticSearchAction,
  graphStatsAction,
  ontologyNeighborsAction,
  ontologyQueryAction,
} from "./actions";

const BASE = { orgSlug: "acme", workspaceSlug: "core" };
const DENY_ERROR = /you must be a workspace member/i;

beforeEach(() => {
  vi.clearAllMocks();
  dbState.role = "owner";
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveOrg.mockResolvedValue({ id: "org-1" });
  mockResolveWorkspace.mockResolvedValue({ id: "ws-1" });
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockRunInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  mockWithTenantDb.mockImplementation(async () => [{ role: dbState.role }]);
});

describe("listNodesAction", () => {
  it("invokes list_nodes with { surface: agent } and maps the result", async () => {
    mockInvoke.mockResolvedValue({
      nodes: [
        { id: "pub-1", labels: ["Feature"], properties: {}, displayName: "A" },
      ],
      total: 1,
      hasMore: false,
      limit: 50,
      offset: 0,
    });
    const res = await listNodesAction({
      ...BASE,
      labels: ["Feature"],
      limit: 50,
      offset: 0,
    });
    expect(res.ok).toBe(true);
    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("list_nodes");
    expect(input).toEqual({ labels: ["Feature"], limit: 50, offset: 0 });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("denies a non-workspace-member without calling invoke", async () => {
    dbState.role = "viewer";
    const res = await listNodesAction(BASE);
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(DENY_ERROR),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false with the error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j down"));
    const res = await listNodesAction(BASE);
    expect(res).toEqual({ ok: false, error: "neo4j down" });
  });
});

describe("searchNodesAction", () => {
  it("invokes search_nodes with { surface: agent }", async () => {
    mockInvoke.mockResolvedValue({
      nodes: [
        {
          nodeId: "pub-1",
          label: "Feature",
          displayName: "A",
          description: null,
          score: 1,
        },
      ],
    });
    const res = await searchNodesAction({ ...BASE, query: "bill" });
    expect(res).toEqual({
      ok: true,
      nodes: [
        {
          nodeId: "pub-1",
          label: "Feature",
          displayName: "A",
          description: null,
          score: 1,
        },
      ],
    });
    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("search_nodes");
    expect(input).toEqual({ query: "bill" });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("denies a non-workspace-member", async () => {
    dbState.role = "";
    const res = await searchNodesAction({ ...BASE, query: "bill" });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(DENY_ERROR),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("search index down"));
    const res = await searchNodesAction({ ...BASE, query: "bill" });
    expect(res).toEqual({ ok: false, error: "search index down" });
  });
});

describe("semanticSearchAction", () => {
  it("invokes search_graph with { surface: agent }", async () => {
    mockInvoke.mockResolvedValue({
      results: [
        {
          nodeId: "pub-1",
          label: "SourceFile",
          displayName: "billing.ts",
          kind: "entity",
          snippet: "charge()",
          score: 0.9,
        },
      ],
    });
    const res = await semanticSearchAction({
      ...BASE,
      query: "charging logic",
    });
    expect(res.ok).toBe(true);
    const [cap, , , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("search_graph");
    expect(opts).toEqual({ surface: "agent" });
  });

  it("denies a non-workspace-member", async () => {
    dbState.role = "viewer";
    const res = await semanticSearchAction({ ...BASE, query: "x" });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(DENY_ERROR),
    });
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("embedding service down"));
    const res = await semanticSearchAction({ ...BASE, query: "x" });
    expect(res).toEqual({ ok: false, error: "embedding service down" });
  });
});

describe("graphStatsAction", () => {
  it("invokes get_graph_stats with { surface: agent } and strips render", async () => {
    mockInvoke.mockResolvedValue({
      nodeCount: 10,
      edgeCount: 5,
      inferredEdgeCount: 1,
      sourceCount: 2,
      lastModifiedAt: "2026-01-01T00:00:00.000Z",
      render: { componentId: "graph-stats", props: {} },
    });
    const res = await graphStatsAction({ ...BASE, includeByType: true });
    expect(res).toEqual({
      ok: true,
      stats: {
        nodeCount: 10,
        edgeCount: 5,
        inferredEdgeCount: 1,
        sourceCount: 2,
        lastModifiedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("get_graph_stats");
    expect(input).toEqual({ includeByType: true });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("denies a non-workspace-member", async () => {
    dbState.role = "";
    const res = await graphStatsAction(BASE);
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(DENY_ERROR),
    });
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("stats query failed"));
    const res = await graphStatsAction(BASE);
    expect(res).toEqual({ ok: false, error: "stats query failed" });
  });
});

describe("ontologyNeighborsAction", () => {
  it("invokes get_ontology_neighbors with { surface: agent }", async () => {
    mockInvoke.mockResolvedValue({
      nodeId: "pub-1",
      found: true,
      truncated: false,
      neighbors: [],
    });
    const res = await ontologyNeighborsAction({
      ...BASE,
      nodeId: "pub-1",
      limit: 25,
    });
    expect(res).toEqual({
      ok: true,
      nodeId: "pub-1",
      found: true,
      truncated: false,
      neighbors: [],
    });
    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("get_ontology_neighbors");
    expect(input).toEqual({ nodeId: "pub-1", limit: 25 });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("denies a non-workspace-member without calling invoke", async () => {
    dbState.role = "viewer";
    const res = await ontologyNeighborsAction({ ...BASE, nodeId: "pub-1" });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(DENY_ERROR),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("node not found"));
    const res = await ontologyNeighborsAction({ ...BASE, nodeId: "pub-1" });
    expect(res).toEqual({ ok: false, error: "node not found" });
  });
});

describe("ontologyQueryAction", () => {
  it("invokes query_ontology with { surface: agent }", async () => {
    mockInvoke.mockResolvedValue({
      startNode: {
        nodeId: "pub-1",
        label: "Feature",
        displayName: "A",
        description: null,
        depth: 0,
      },
      nodes: [],
      edges: [],
      truncated: false,
    });
    const res = await ontologyQueryAction({
      ...BASE,
      startNodeId: "pub-1",
      direction: "out",
      maxDepth: 2,
    });
    expect(res.ok).toBe(true);
    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("query_ontology");
    expect(input).toEqual({
      startNodeId: "pub-1",
      direction: "out",
      maxDepth: 2,
    });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("denies a non-workspace-member without calling invoke", async () => {
    dbState.role = "";
    const res = await ontologyQueryAction({ ...BASE, startNodeId: "pub-1" });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /you must be a workspace member to traverse the graph/i,
      ),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("traversal timed out"));
    const res = await ontologyQueryAction({ ...BASE, startNodeId: "pub-1" });
    expect(res).toEqual({ ok: false, error: "traversal timed out" });
  });
});
