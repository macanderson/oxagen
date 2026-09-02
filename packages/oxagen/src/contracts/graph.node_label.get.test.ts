import { describe, expect, it } from "vitest";
import { graphNodeLabelsGet } from "./graph.node_label.get";

describe("graph.node.labels.get contract", () => {
  it("is a read-only agent primitive readable by viewers", () => {
    expect(graphNodeLabelsGet.name).toBe("get_node_labels");
    expect(graphNodeLabelsGet.surfaces).toContain("agent");
    expect(graphNodeLabelsGet.agent?.requiresApproval).toBe(false);
    expect(graphNodeLabelsGet.defaultRoles.workspace.Viewer).toBe("allow");
  });

  it("requires a non-empty nodeId", () => {
    expect(graphNodeLabelsGet.input.parse({ nodeId: "n_1" }).nodeId).toBe(
      "n_1",
    );
    expect(() => graphNodeLabelsGet.input.parse({ nodeId: "" })).toThrow();
  });

  it("validates the output label set", () => {
    const parsed = graphNodeLabelsGet.output.parse({
      nodeId: "n_1",
      labels: ["Payment", "Billing"],
    });
    expect(parsed.labels).toEqual(["Payment", "Billing"]);
  });
});
