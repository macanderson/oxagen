/**
 * explore-service.test.ts — composition logic for the graph-explorer ops.
 *
 * The kernel (`invoke`), the tenant-scope wrapper, and the handler-registry
 * side-effect import are all mocked so the test exercises only the assembly
 * maths (which capabilities are called per op and how their outputs are folded
 * into the wire payloads).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Side-effect import in the SUT — stub it so no real handlers register.
vi.mock("@oxagen/handlers/register", () => ({}));
// runInTenantScope just runs the callback in tests.
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
// The kernel boundary.
const invokeMock = vi.fn();
vi.mock("@oxagen/oxagen", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { dispatchExplore } from "./explore-service";
import type {
  ExplorerExpandPayload,
  ExplorerGraphPayload,
  ExplorerNodeDetailPayload,
  ExplorerNodesPayload,
  ExplorerSearchPayload,
} from "./types";

const ctx = {
  orgId: "org",
  workspaceId: "ws",
  userId: "user",
  apiKeyId: null,
  requestId: "req",
  surface: "app" as const,
  messageId: null,
};

const tenant = { orgSlug: "o", workspaceSlug: "w" };

function routeInvoke(handlers: Record<string, (input: unknown) => unknown>) {
  invokeMock.mockImplementation((name: string, input: unknown) => {
    const fn = handlers[name];
    if (!fn) throw new Error(`unexpected invoke: ${name}`);
    // Mirror the real kernel: invoke() is async, so a handler throw surfaces as
    // a REJECTED promise (not a synchronous throw) — that is what the service's
    // `.catch(...)` fallbacks rely on.
    return Promise.resolve().then(() => fn(input));
  });
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("dispatchExplore — graph", () => {
  it("assembles seed nodes, confirmed edges, and stats", async () => {
    routeInvoke({
      get_graph_stats: () => ({
        nodeCount: 3,
        edgeCount: 2,
        inferredEdgeCount: 1,
        nodesByLabel: { Issue: 2, Topic: 1 },
        edgesByType: { REL: 2 },
        lastModifiedAt: "",
      }),
      list_nodes: () => ({
        nodes: [
          {
            id: "a",
            labels: ["KnowledgeNode", "Issue"],
            displayName: "A",
            properties: {},
          },
          {
            id: "b",
            labels: ["KnowledgeNode", "Topic"],
            displayName: "B",
            properties: {},
          },
        ],
        total: 3,
        hasMore: true,
        limit: 60,
        offset: 0,
      }),
      get_ontology_neighbors: (input) => {
        const nodeId = (input as { nodeId: string }).nodeId;
        if (nodeId === "a") {
          return {
            nodeId: "a",
            found: true,
            neighbors: [
              {
                nodeId: "b",
                label: "Topic",
                displayName: "B",
                description: null,
                edgeType: "REL",
                direction: "out",
              },
            ],
            truncated: false,
          };
        }
        return { nodeId, found: true, neighbors: [], truncated: false };
      },
    });

    const result = (await dispatchExplore(
      { op: "graph", ...tenant },
      ctx,
    )) as ExplorerGraphPayload;

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    // Confirmed edge from the neighbor walk.
    expect(
      result.edges.find((e) => e.type === "REL" && !e.inferred),
    ).toBeTruthy();
    expect(result.edges).toHaveLength(1);
    expect(result.stats).toMatchObject({
      nodeCount: 3,
      edgeCount: 2,
      inferredEdgeCount: 1,
    });
    expect(result.stats.nodesByLabel).toContainEqual({
      type: "Issue",
      count: 2,
    });
    expect(result.truncated).toBe(true); // 3 total > 2 in view
  });

  it("does not expose an ownership override to list_nodes", async () => {
    routeInvoke({
      get_graph_stats: () => ({
        nodeCount: 0,
        edgeCount: 0,
        inferredEdgeCount: 0,
        nodesByLabel: {},
        edgesByType: {},
        lastModifiedAt: "",
      }),
      list_nodes: () => ({
        nodes: [],
        total: 0,
        hasMore: false,
        limit: 60,
        offset: 0,
      }),
    });

    await dispatchExplore({ op: "graph", ...tenant }, ctx);
    const listCall = invokeMock.mock.calls.find((c) => c[0] === "list_nodes");
    expect(listCall?.[1]).not.toHaveProperty("isSystem");
  });
});

describe("dispatchExplore — expand", () => {
  it("returns the node's neighborhood as nodes + edges", async () => {
    routeInvoke({
      get_ontology_neighbors: () => ({
        nodeId: "a",
        found: true,
        neighbors: [
          {
            nodeId: "b",
            label: "Topic",
            displayName: "B",
            description: null,
            edgeType: "REL",
            direction: "in",
          },
        ],
        truncated: false,
      }),
    });

    const result = (await dispatchExplore(
      { op: "expand", ...tenant, nodeId: "a" },
      ctx,
    )) as ExplorerExpandPayload;
    expect(result.found).toBe(true);
    expect(result.nodes[0]).toMatchObject({ id: "b", hydrated: false });
    expect(result.edges[0]).toMatchObject({
      source: "b",
      target: "a",
      type: "REL",
    });
  });
});

describe("dispatchExplore — nodes", () => {
  it("maps the paginated list", async () => {
    routeInvoke({
      list_nodes: () => ({
        nodes: [
          {
            id: "a",
            labels: ["KnowledgeNode", "Issue"],
            displayName: "A",
            properties: {},
            createdAt: "2026-01-01",
          },
        ],
        total: 42,
        hasMore: true,
        limit: 25,
        offset: 0,
      }),
    });

    const result = (await dispatchExplore(
      { op: "nodes", ...tenant, limit: 25, offset: 0 },
      ctx,
    )) as ExplorerNodesPayload;
    expect(result).toMatchObject({
      total: 42,
      hasMore: true,
      limit: 25,
      offset: 0,
    });
    expect(result.nodes[0]).toMatchObject({
      id: "a",
      label: "Issue",
      hydrated: true,
    });
    // Customer-only ownership is enforced by list_nodes itself.
    expect(
      invokeMock.mock.calls.find((c) => c[0] === "list_nodes")?.[1],
    ).not.toHaveProperty("isSystem");
  });
});

describe("dispatchExplore — search", () => {
  it("maps search hits to stub nodes", async () => {
    routeInvoke({
      search_nodes: () => ({
        nodes: [
          {
            nodeId: "x",
            label: "Issue",
            displayName: "X",
            description: "d",
            score: 1,
          },
        ],
      }),
    });

    const result = (await dispatchExplore(
      { op: "search", ...tenant, query: "x" },
      ctx,
    )) as ExplorerSearchPayload;
    expect(result.nodes[0]).toMatchObject({
      id: "x",
      label: "Issue",
      displayName: "X",
      hydrated: false,
    });
  });
});

describe("dispatchExplore — node detail", () => {
  it("returns the node with properties and neighbors", async () => {
    routeInvoke({
      get_node: () => ({
        node: {
          nodeId: "a",
          label: "Issue",
          displayName: "A",
          description: null,
          properties: { p: 1 },
          createdAt: "",
          updatedAt: null,
        },
      }),
      get_ontology_neighbors: () => ({
        nodeId: "a",
        found: true,
        neighbors: [
          {
            nodeId: "b",
            label: "Topic",
            displayName: "B",
            description: null,
            edgeType: "REL",
            direction: "out",
          },
        ],
        truncated: false,
      }),
    });

    const result = (await dispatchExplore(
      { op: "node", ...tenant, nodeId: "a" },
      ctx,
    )) as ExplorerNodeDetailPayload;
    expect(result.node).toMatchObject({
      id: "a",
      label: "Issue",
      hydrated: true,
      degree: 1,
    });
    expect(result.node?.properties).toEqual({ p: 1 });
    expect(result.neighbors[0]).toMatchObject({
      nodeId: "b",
      edgeType: "REL",
      direction: "out",
    });
  });

  it("returns null node when the node is missing", async () => {
    routeInvoke({
      get_node: () => ({ node: null }),
      get_ontology_neighbors: () => ({
        nodeId: "a",
        found: false,
        neighbors: [],
        truncated: false,
      }),
    });

    const result = (await dispatchExplore(
      { op: "node", ...tenant, nodeId: "a" },
      ctx,
    )) as ExplorerNodeDetailPayload;
    expect(result.node).toBeNull();
    expect(result.neighbors).toEqual([]);
  });
});
