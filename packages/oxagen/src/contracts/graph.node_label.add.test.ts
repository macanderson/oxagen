import { describe, expect, it } from "vitest";
import { graphNodeLabelAdd } from "./graph.node_label.add";

describe("graph.node.label.add contract", () => {
  it("is an agent-only graph primitive requiring approval", () => {
    expect(graphNodeLabelAdd.name).toBe("add_node_label");
    expect(graphNodeLabelAdd.surfaces).toContain("agent");
    expect(graphNodeLabelAdd.surfaces).not.toContain("api");
    expect(graphNodeLabelAdd.surfaces).not.toContain("mcp");
    expect(graphNodeLabelAdd.agent?.requiresApproval).toBe(true);
    expect(graphNodeLabelAdd.scoped).toBe(true);
  });

  it("accepts a node id with one or more valid labels", () => {
    const parsed = graphNodeLabelAdd.input.parse({ nodeId: "n_1", labels: ["Billing", "Pii"] });
    expect(parsed.labels).toEqual(["Billing", "Pii"]);
  });

  it("rejects an empty label array", () => {
    expect(() => graphNodeLabelAdd.input.parse({ nodeId: "n_1", labels: [] })).toThrow();
  });

  it("rejects a label that violates LABEL_PATTERN", () => {
    expect(() => graphNodeLabelAdd.input.parse({ nodeId: "n_1", labels: ["bad-label"] })).toThrow();
  });

  it("validates the output (full label set + added)", () => {
    const parsed = graphNodeLabelAdd.output.parse({
      nodeId: "n_1",
      labels: ["Payment", "Billing"],
      added: ["Billing"],
    });
    expect(parsed.added).toEqual(["Billing"]);
  });
});
