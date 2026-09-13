import { describe, it, expect } from "vitest";
import {
  primaryLabel,
  nodeFromListed,
  nodeFromNeighbor,
  edgeId,
  edgesFromNeighbors,
  mergeNodes,
  mergeEdges,
  reconcile,
  countNodesByLabel,
  countEdgesByType,
  recordToCounts,
} from "./transform";
import type { ExplorerEdge, ExplorerNode } from "../types";

describe("primaryLabel", () => {
  it("prefers the first non-base label", () => {
    expect(primaryLabel(["KnowledgeNode", "Issue"])).toBe("Issue");
  });
  it("falls back to the first label when only the base is present", () => {
    expect(primaryLabel(["KnowledgeNode"])).toBe("KnowledgeNode");
  });
  it("defaults to Node for an empty array", () => {
    expect(primaryLabel([])).toBe("Node");
  });
});

describe("nodeFromListed", () => {
  it("maps a listed row to a hydrated node", () => {
    const node = nodeFromListed({
      id: "n1",
      labels: ["KnowledgeNode", "Issue"],
      displayName: "Bug",
      properties: { a: 1 },
      sourceId: "src",
      createdAt: "2026-01-01",
    });
    expect(node).toMatchObject({
      id: "n1",
      label: "Issue",
      displayName: "Bug",
      hydrated: true,
      degree: 0,
      sourceId: "src",
    });
    expect(node.properties).toEqual({ a: 1 });
  });
  it("omits absent optional fields", () => {
    const node = nodeFromListed({
      id: "n1",
      labels: ["Issue"],
      displayName: "X",
    });
    expect(node.sourceId).toBeUndefined();
    expect(node.createdAt).toBeUndefined();
  });
});

describe("nodeFromNeighbor", () => {
  it("maps a neighbor to an unhydrated stub", () => {
    const node = nodeFromNeighbor({
      nodeId: "n2",
      label: "Topic",
      displayName: "AI",
      edgeType: "RELATED_TO",
      direction: "out",
    });
    expect(node).toMatchObject({
      id: "n2",
      label: "Topic",
      displayName: "AI",
      hydrated: false,
    });
  });
});

describe("edgeId / edgesFromNeighbors", () => {
  it("builds a stable synthetic id", () => {
    expect(edgeId("a", "b", "REL")).toBe("a->b:REL");
  });
  it("orients edges by direction", () => {
    const out = edgesFromNeighbors("anchor", [
      {
        nodeId: "b",
        label: "X",
        displayName: "B",
        edgeType: "REL",
        direction: "out",
      },
      {
        nodeId: "c",
        label: "Y",
        displayName: "C",
        edgeType: "REL",
        direction: "in",
      },
    ]);
    expect(out[0]).toMatchObject({
      source: "anchor",
      target: "b",
      inferred: false,
    });
    expect(out[1]).toMatchObject({
      source: "c",
      target: "anchor",
      inferred: false,
    });
  });
});

function node(id: string, label = "Issue", hydrated = false): ExplorerNode {
  return { id, label, displayName: id, degree: 0, hydrated };
}
function edge(source: string, target: string, type = "REL"): ExplorerEdge {
  return {
    id: edgeId(source, target, type),
    source,
    target,
    type,
    inferred: false,
  };
}

describe("mergeNodes", () => {
  it("dedupes by id", () => {
    const out = mergeNodes([node("a")], [node("a"), node("b")]);
    expect(out.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });
  it("upgrades a stub to a hydrated node", () => {
    const out = mergeNodes(
      [node("a", "Issue", false)],
      [node("a", "Issue", true)],
    );
    expect(out.find((n) => n.id === "a")?.hydrated).toBe(true);
  });
  it("does not downgrade a hydrated node back to a stub", () => {
    const out = mergeNodes(
      [node("a", "Issue", true)],
      [node("a", "Issue", false)],
    );
    expect(out.find((n) => n.id === "a")?.hydrated).toBe(true);
  });
});

describe("mergeEdges", () => {
  it("dedupes by synthetic id", () => {
    const out = mergeEdges([edge("a", "b")], [edge("a", "b"), edge("b", "c")]);
    expect(out).toHaveLength(2);
  });
});

describe("reconcile", () => {
  it("drops edges with a missing endpoint and computes degree", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b"), edge("a", "ghost")];
    const out = reconcile(nodes, edges);
    expect(out.edges).toHaveLength(1);
    expect(out.nodes.find((n) => n.id === "a")?.degree).toBe(1);
    expect(out.nodes.find((n) => n.id === "b")?.degree).toBe(1);
  });
  it("assigns zero degree to isolated nodes", () => {
    const out = reconcile([node("solo")], []);
    expect(out.nodes[0]?.degree).toBe(0);
  });
});

describe("counts", () => {
  it("counts nodes by label descending", () => {
    const out = countNodesByLabel([
      node("a", "Issue"),
      node("b", "Issue"),
      node("c", "Topic"),
    ]);
    expect(out[0]).toEqual({ type: "Issue", count: 2 });
    expect(out[1]).toEqual({ type: "Topic", count: 1 });
  });
  it("counts edges by type", () => {
    const out = countEdgesByType([
      edge("a", "b", "REL"),
      edge("b", "c", "REL"),
      edge("c", "d", "PART_OF"),
    ]);
    expect(out.find((t) => t.type === "REL")?.count).toBe(2);
  });
  it("converts a record to sorted counts, dropping the base label", () => {
    const out = recordToCounts({ Issue: 5, Topic: 2, KnowledgeNode: 99 });
    expect(out).toEqual([
      { type: "Issue", count: 5 },
      { type: "Topic", count: 2 },
    ]);
  });
  it("returns an empty array for an undefined record", () => {
    expect(recordToCounts(undefined)).toEqual([]);
  });
});
