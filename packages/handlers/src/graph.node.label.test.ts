/**
 * graph.node.label.add / .remove / .labels.get handler tests.
 * Mocks scopedSession() so no real Neo4j is required. Verifies multi-label
 * Cypher construction, the LABEL_PATTERN injection guard, the BASE_LABEL
 * filtering, and the added/removed deltas.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

import { graphNodeLabelAddHandler } from "./graph.node.label.add";
import { graphNodeLabelRemoveHandler } from "./graph.node.label.remove";
import { graphNodeLabelsGetHandler } from "./graph.node.labels.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

function rec(fields: Record<string, unknown>) {
  return { records: [{ get: (k: string) => fields[k] ?? null }] };
}

beforeEach(() => vi.clearAllMocks());

describe("graphNodeLabelAddHandler", () => {
  it("adds multiple labels and returns the resulting set + added delta", async () => {
    mocks.run.mockResolvedValueOnce(
      rec({ after: ["KnowledgeNode", "Payment", "Billing", "Pii"], before: ["KnowledgeNode", "Payment"] }),
    );
    const out = await graphNodeLabelAddHandler({ nodeId: "n1", labels: ["Billing", "Pii"] }, CTX);
    expect(out.labels).toEqual(["Payment", "Billing", "Pii"]); // KnowledgeNode filtered
    expect(out.added).toEqual(["Billing", "Pii"]);
  });

  it("builds a multi-label SET clause and never parameterizes the label", async () => {
    mocks.run.mockResolvedValueOnce(rec({ after: ["KnowledgeNode", "Billing"], before: ["KnowledgeNode"] }));
    await graphNodeLabelAddHandler({ nodeId: "n1", labels: ["Billing"] }, CTX);
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).toContain("SET n:`Billing`");
    expect(cypher).toContain("MATCH (n:KnowledgeNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})");
  });

  it("idempotent: a label already present is not reported as added", async () => {
    mocks.run.mockResolvedValueOnce(
      rec({ after: ["KnowledgeNode", "Billing"], before: ["KnowledgeNode", "Billing"] }),
    );
    const out = await graphNodeLabelAddHandler({ nodeId: "n1", labels: ["Billing"] }, CTX);
    expect(out.added).toEqual([]);
  });

  it("rejects an injection label before touching Cypher", async () => {
    await expect(
      graphNodeLabelAddHandler({ nodeId: "n1", labels: ["`]->()-[:x"] }, CTX),
    ).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("throws when the node is not found", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await expect(graphNodeLabelAddHandler({ nodeId: "missing", labels: ["Billing"] }, CTX)).rejects.toThrow(
      'node "missing" not found',
    );
  });
});

describe("graphNodeLabelRemoveHandler", () => {
  it("removes labels and reports the removed delta", async () => {
    mocks.run.mockResolvedValueOnce(
      rec({ after: ["KnowledgeNode", "Payment"], before: ["KnowledgeNode", "Payment", "Billing"] }),
    );
    const out = await graphNodeLabelRemoveHandler({ nodeId: "n1", labels: ["Billing"] }, CTX);
    expect(out.labels).toEqual(["Payment"]);
    expect(out.removed).toEqual(["Billing"]);
    expect(mocks.run.mock.calls[0]?.[0]).toContain("REMOVE n:`Billing`");
  });

  it("refuses to remove the internal base label (no-op)", async () => {
    const out = await graphNodeLabelRemoveHandler({ nodeId: "n1", labels: ["KnowledgeNode"] }, CTX);
    expect(out.removed).toEqual([]);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("graphNodeLabelsGetHandler", () => {
  it("returns the label set minus the internal base label", async () => {
    mocks.run.mockResolvedValueOnce(rec({ labels: ["KnowledgeNode", "Billing", "Payment"] }));
    const out = await graphNodeLabelsGetHandler({ nodeId: "n1" }, CTX);
    expect(out.labels).toEqual(["Billing", "Payment"]);
  });

  it("throws when the node is not found", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await expect(graphNodeLabelsGetHandler({ nodeId: "x" }, CTX)).rejects.toThrow("not found");
  });

  it("returns an empty array when the node has only the base label", async () => {
    mocks.run.mockResolvedValueOnce(rec({ labels: ["KnowledgeNode"] }));
    const out = await graphNodeLabelsGetHandler({ nodeId: "n1" }, CTX);
    expect(out.labels).toEqual([]);
  });

  it("includes the nodeId in the response", async () => {
    mocks.run.mockResolvedValueOnce(rec({ labels: ["KnowledgeNode", "Billing"] }));
    const out = await graphNodeLabelsGetHandler({ nodeId: "my-node" }, CTX);
    expect(out.nodeId).toBe("my-node");
  });
});

describe("graphNodeLabelRemoveHandler — additional branches", () => {
  it("rejects an injection label before touching Cypher", async () => {
    await expect(
      graphNodeLabelRemoveHandler({ nodeId: "n1", labels: ["`DROP ALL"] }, CTX),
    ).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("throws when the node is not found during remove", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await expect(graphNodeLabelRemoveHandler({ nodeId: "missing", labels: ["Payment"] }, CTX)).rejects.toThrow(
      'node "missing" not found',
    );
  });

  it("removed delta is empty when the label was not on the node before", async () => {
    mocks.run.mockResolvedValueOnce(
      rec({ after: ["KnowledgeNode", "Payment"], before: ["KnowledgeNode", "Payment"] }),
    );
    const out = await graphNodeLabelRemoveHandler({ nodeId: "n1", labels: ["Billing"] }, CTX);
    // Billing wasn't in before → removed should be empty
    expect(out.removed).toEqual([]);
    // labels should still exclude KnowledgeNode
    expect(out.labels).toEqual(["Payment"]);
  });

  it("removes multiple labels at once", async () => {
    mocks.run.mockResolvedValueOnce(
      rec({ after: ["KnowledgeNode"], before: ["KnowledgeNode", "Billing", "Payment"] }),
    );
    const out = await graphNodeLabelRemoveHandler({ nodeId: "n1", labels: ["Billing", "Payment"] }, CTX);
    expect(out.removed).toEqual(["Billing", "Payment"]);
    expect(out.labels).toEqual([]);
  });
});

describe("graphNodeLabelAddHandler — additional branches", () => {
  it("includes nodeId in the response", async () => {
    mocks.run.mockResolvedValueOnce(
      rec({ after: ["KnowledgeNode", "Billing"], before: ["KnowledgeNode"] }),
    );
    const out = await graphNodeLabelAddHandler({ nodeId: "my-node", labels: ["Billing"] }, CTX);
    expect(out.nodeId).toBe("my-node");
  });

  it("partial add: only newly added labels appear in the added delta", async () => {
    // before has Payment; Billing is new
    mocks.run.mockResolvedValueOnce(
      rec({ after: ["KnowledgeNode", "Payment", "Billing"], before: ["KnowledgeNode", "Payment"] }),
    );
    const out = await graphNodeLabelAddHandler({ nodeId: "n1", labels: ["Payment", "Billing"] }, CTX);
    expect(out.added).toEqual(["Billing"]);
    expect(out.labels).toContain("Payment");
    expect(out.labels).toContain("Billing");
  });
});
