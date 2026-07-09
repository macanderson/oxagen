import { describe, expect, it } from "vitest";
import { graphNodeLabelRemove } from "./graph.node_label.remove";

describe("graph.node.label.remove contract", () => {
  it("is an agent-only graph primitive requiring approval", () => {
    expect(graphNodeLabelRemove.name).toBe("remove_node_label");
    expect(graphNodeLabelRemove.surfaces).toContain("agent");
    expect(graphNodeLabelRemove.surfaces).not.toContain("api");
    expect(graphNodeLabelRemove.agent?.requiresApproval).toBe(true);
  });

  it("accepts a node id with valid labels", () => {
    const parsed = graphNodeLabelRemove.input.parse({ nodeId: "n_1", labels: ["Billing"] });
    expect(parsed.labels).toEqual(["Billing"]);
  });

  it("rejects an empty label array and invalid labels", () => {
    expect(() => graphNodeLabelRemove.input.parse({ nodeId: "n_1", labels: [] })).toThrow();
    expect(() => graphNodeLabelRemove.input.parse({ nodeId: "n_1", labels: ["has space"] })).toThrow();
  });

  it("validates the output (full label set + removed)", () => {
    const parsed = graphNodeLabelRemove.output.parse({
      nodeId: "n_1",
      labels: ["Payment"],
      removed: ["Billing"],
    });
    expect(parsed.removed).toEqual(["Billing"]);
  });
});
