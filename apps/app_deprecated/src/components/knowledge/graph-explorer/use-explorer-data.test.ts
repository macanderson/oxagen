// @vitest-environment jsdom
/**
 * use-explorer-data.test.ts — renderHook tests for useExplorerData.
 *
 * Covers: initial graph load (status → ready, nodes present), expand merges
 * new nodes and edges and recomputes degrees, reload triggers a fresh fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useExplorerData } from "./use-explorer-data";
import { fetchGraph, expandNode } from "./api-client";

afterEach(cleanup);

vi.mock("./api-client", () => ({
  fetchGraph: vi.fn(),
  expandNode: vi.fn(),
}));

const mockFetchGraph = vi.mocked(fetchGraph);
const mockExpandNode = vi.mocked(expandNode);

const initialPayload = {
  nodes: [
    { id: "a", label: "Issue", displayName: "A", degree: 0, hydrated: true },
  ],
  edges: [],
  stats: {
    nodeCount: 1,
    edgeCount: 0,
    inferredEdgeCount: 0,
    nodesByLabel: [{ type: "Issue", count: 1 }],
    edgesByType: [],
  },
  truncated: false,
};

const tenant = { orgSlug: "o", workspaceSlug: "w" };

beforeEach(() => {
  mockFetchGraph.mockResolvedValue(initialPayload);
  mockExpandNode.mockResolvedValue({ found: true, nodes: [], edges: [] });
});

describe("useExplorerData — initial load", () => {
  it("starts in loading status", () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    expect(result.current.status).toBe("loading");
  });

  it("transitions to ready status after fetchGraph resolves", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("populates nodes from the fetchGraph response", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0]?.id).toBe("a");
  });

  it("sets stats from the response", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.stats?.nodeCount).toBe(1);
  });

  it("sets truncated from the response", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.truncated).toBe(false);
  });

  it("starts with no error", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.error).toBeNull();
  });
});

describe("useExplorerData — customer context", () => {
  it("fetches the graph without an ownership override", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockFetchGraph).toHaveBeenCalledWith(tenant, {}, expect.anything());
  });
});

describe("useExplorerData — error state", () => {
  it("transitions to error status when fetchGraph rejects", async () => {
    mockFetchGraph.mockRejectedValue(new Error("Network down"));
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Network down");
  });
});

describe("useExplorerData — expand", () => {
  it("merges new nodes returned by expandNode", async () => {
    mockExpandNode.mockResolvedValue({
      found: true,
      nodes: [
        {
          id: "b",
          label: "Topic",
          displayName: "B",
          degree: 0,
          hydrated: true,
        },
      ],
      edges: [
        {
          id: "a->b:REL",
          source: "a",
          target: "b",
          type: "REL",
          inferred: false,
        },
      ],
    });

    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.expand("a");
    });

    const ids = result.current.nodes.map((n) => n.id);
    expect(ids).toContain("b");
  });

  it("merges new edges returned by expandNode", async () => {
    mockExpandNode.mockResolvedValue({
      found: true,
      nodes: [
        {
          id: "b",
          label: "Topic",
          displayName: "B",
          degree: 0,
          hydrated: true,
        },
      ],
      edges: [
        {
          id: "a->b:REL",
          source: "a",
          target: "b",
          type: "REL",
          inferred: false,
        },
      ],
    });

    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.expand("a");
    });

    const edgeIds = result.current.edges.map((e) => e.id);
    expect(edgeIds).toContain("a->b:REL");
  });

  it("recomputes degrees after expand (node 'a' has degree 1 after edge a->b)", async () => {
    mockExpandNode.mockResolvedValue({
      found: true,
      nodes: [
        {
          id: "b",
          label: "Topic",
          displayName: "B",
          degree: 0,
          hydrated: true,
        },
      ],
      edges: [
        {
          id: "a->b:REL",
          source: "a",
          target: "b",
          type: "REL",
          inferred: false,
        },
      ],
    });

    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.expand("a");
    });

    const nodeA = result.current.nodes.find((n) => n.id === "a");
    expect(nodeA?.degree).toBe(1);
  });

  it("does not change nodes when expandNode returns found=false", async () => {
    mockExpandNode.mockResolvedValue({ found: false, nodes: [], edges: [] });

    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const beforeCount = result.current.nodes.length;

    await act(async () => {
      await result.current.expand("a");
    });

    expect(result.current.nodes).toHaveLength(beforeCount);
  });

  it("clears expandingId after expand completes", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.expand("a");
    });

    expect(result.current.expandingId).toBeNull();
  });

  it("does not throw when expandNode rejects (non-fatal)", async () => {
    mockExpandNode.mockRejectedValue(new Error("expand failed"));

    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await expect(
      act(async () => {
        await result.current.expand("a");
      }),
    ).resolves.toBeUndefined();

    // Status unchanged
    expect(result.current.status).toBe("ready");
  });
});

describe("useExplorerData — reload", () => {
  it("calling reload triggers a second fetchGraph call", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockFetchGraph).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reload();
    });

    await waitFor(() => expect(mockFetchGraph).toHaveBeenCalledTimes(2));
  });
});

describe("useExplorerData — addSubgraph", () => {
  it("addSubgraph merges additional nodes into the view", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.addSubgraph(
        [
          {
            id: "c",
            label: "Doc",
            displayName: "C",
            degree: 0,
            hydrated: true,
          },
        ],
        [],
      );
    });

    const ids = result.current.nodes.map((n) => n.id);
    expect(ids).toContain("c");
  });

  it("addSubgraph deduplicates nodes already in the view", async () => {
    const { result } = renderHook(() => useExplorerData(tenant));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.addSubgraph(
        [
          {
            id: "a",
            label: "Issue",
            displayName: "A",
            degree: 0,
            hydrated: true,
          },
        ],
        [],
      );
    });

    // Node "a" should not be duplicated
    const ids = result.current.nodes.map((n) => n.id);
    const aCount = ids.filter((id) => id === "a").length;
    expect(aCount).toBe(1);
  });
});
