import { describe, it, expect } from "vitest";
import {
  fromListNode,
  fromSearchNode,
  fromSemanticResult,
  fromNeighbor,
  fromTraversedNode,
  tryNodeRefFromCell,
} from "./node-ref-adapters";

describe("fromListNode", () => {
  it("maps the first label and preserves properties", () => {
    const ref = fromListNode({
      id: "pub-1",
      labels: ["Feature", "Anchor"],
      properties: { owner: "platform" },
      displayName: "Billing streaming",
    });
    expect(ref).toEqual({
      id: "pub-1",
      label: "Feature",
      displayName: "Billing streaming",
      properties: { owner: "platform" },
    });
  });

  it("falls back to 'Node' when labels is empty", () => {
    const ref = fromListNode({
      id: "pub-2",
      labels: [],
      properties: {},
      displayName: "Untitled",
    });
    expect(ref.label).toBe("Node");
  });

  it("cites the domain label, not the base 'KnowledgeNode' marker", () => {
    // graph.node.list returns [base "KnowledgeNode", domain]; the citation chip
    // must surface the domain label so it isn't painted "KnowledgeNode".
    const ref = fromListNode({
      id: "pub-2b",
      labels: ["KnowledgeNode", "Issue"],
      properties: {},
      displayName: "Login bug",
    });
    expect(ref.label).toBe("Issue");
  });
});

describe("fromSearchNode", () => {
  it("maps nodeId → id and folds description/score into properties", () => {
    const ref = fromSearchNode({
      nodeId: "pub-3",
      label: "Issue",
      displayName: "Login bug",
      description: "Users can't log in",
      score: 1,
    });
    expect(ref).toEqual({
      id: "pub-3",
      label: "Issue",
      displayName: "Login bug",
      properties: { description: "Users can't log in", matchScore: 1 },
    });
  });

  it("omits the description key when null", () => {
    const ref = fromSearchNode({
      nodeId: "pub-4",
      label: "Issue",
      displayName: "Untitled",
      description: null,
      score: 0.5,
    });
    expect(ref.properties).toEqual({ matchScore: 0.5 });
  });
});

describe("fromSemanticResult", () => {
  it("maps nodeId → id and carries kind/snippet/relevance/isSystem", () => {
    const ref = fromSemanticResult({
      nodeId: "pub-5",
      label: "SourceFile",
      displayName: "billing.ts",
      kind: "file",
      snippet: "export function charge()",
      score: 0.87,
      isSystem: true,
    });
    expect(ref).toEqual({
      id: "pub-5",
      label: "SourceFile",
      displayName: "billing.ts",
      properties: {
        kind: "file",
        snippet: "export function charge()",
        relevance: 0.87,
        isSystem: true,
      },
    });
  });
});

describe("fromNeighbor", () => {
  it("maps nodeId → id and carries edgeType/direction", () => {
    const ref = fromNeighbor({
      nodeId: "pub-6",
      label: "Person",
      displayName: "Jane Doe",
      description: null,
      edgeType: "OWNS",
      direction: "out",
      isSystem: false,
      validFrom: null,
      validTo: null,
      recordedAt: null,
      invalidatedAt: null,
    });
    expect(ref.id).toBe("pub-6");
    expect(ref.properties).toEqual({ edgeType: "OWNS", direction: "out" });
  });
});

describe("fromTraversedNode", () => {
  it("maps nodeId → id and carries depth", () => {
    const ref = fromTraversedNode({
      nodeId: "pub-7",
      label: "Topic",
      displayName: "Billing",
      description: "Billing domain",
      depth: 2,
    });
    expect(ref).toEqual({
      id: "pub-7",
      label: "Topic",
      displayName: "Billing",
      properties: { description: "Billing domain", depth: 2 },
    });
  });
});

describe("tryNodeRefFromCell", () => {
  it("detects a raw Neo4j-driver-shaped node (labels + properties)", () => {
    const ref = tryNodeRefFromCell({
      identity: { low: 1, high: 0 },
      labels: ["Feature"],
      properties: { publicId: "pub-8", displayName: "Streaming", owner: "platform" },
    });
    expect(ref).toEqual({
      id: "pub-8",
      label: "Feature",
      displayName: "Streaming",
      properties: { publicId: "pub-8", displayName: "Streaming", owner: "platform" },
    });
  });

  it("falls back through name/publicId when displayName is missing on a raw node", () => {
    const ref = tryNodeRefFromCell({
      labels: ["Feature"],
      properties: { name: "Fallback name" },
    });
    expect(ref?.displayName).toBe("Fallback name");
  });

  it("detects a contract-shaped node ref (id + displayName)", () => {
    const ref = tryNodeRefFromCell({
      id: "pub-9",
      label: "Repository",
      displayName: "oxagen-platform",
      properties: { stars: 12 },
    });
    expect(ref).toEqual({
      id: "pub-9",
      label: "Repository",
      displayName: "oxagen-platform",
      properties: { stars: 12 },
    });
  });

  it("accepts a null id for an unmaterialised candidate", () => {
    const ref = tryNodeRefFromCell({ id: null, displayName: "Pending target" });
    expect(ref).toEqual({ id: null, label: "Node", displayName: "Pending target", properties: {} });
  });

  it("returns null for a plain scalar", () => {
    expect(tryNodeRefFromCell("just a string")).toBeNull();
    expect(tryNodeRefFromCell(42)).toBeNull();
    expect(tryNodeRefFromCell(null)).toBeNull();
    expect(tryNodeRefFromCell(undefined)).toBeNull();
  });

  it("returns null for an array", () => {
    expect(tryNodeRefFromCell([1, 2, 3])).toBeNull();
  });

  it("returns null for a plain object without a displayName", () => {
    expect(tryNodeRefFromCell({ count: 5 })).toBeNull();
  });
});
