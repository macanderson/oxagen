import { describe, it, expect } from "vitest";
import { LABEL_PATTERN, assertSafeLabel } from "./label-pattern";
import { graphNodeLabelAdd } from "../contracts/graph.node_label.add";
import { graphNodeLabelRemove } from "../contracts/graph.node_label.remove";
import { graphNodeLabelsGet } from "../contracts/graph.node_label.get";

describe("LABEL_PATTERN", () => {
  it("accepts valid Neo4j labels (PascalCase, snake, mixed case)", () => {
    for (const ok of ["Billing", "Payment", "PII", "billing", "Node_1", "Code", "A"]) {
      expect(LABEL_PATTERN.test(ok)).toBe(true);
      expect(() => assertSafeLabel(ok)).not.toThrow();
    }
  });

  it("rejects empty, leading-digit, and Cypher-injection strings", () => {
    for (const bad of ["", "1Bad", "has space", "`]->()-[:x", "a:b", "Foo-Bar", "Foo.Bar", "x".repeat(64)]) {
      expect(LABEL_PATTERN.test(bad)).toBe(false);
      expect(() => assertSafeLabel(bad)).toThrow();
    }
  });
});

describe("graph.node.label.* contracts", () => {
  it("label.add accepts multi-label input and rejects unsafe labels", () => {
    expect(graphNodeLabelAdd.input.parse({ nodeId: "n1", labels: ["Billing", "Pii"] })).toEqual({
      nodeId: "n1",
      labels: ["Billing", "Pii"],
    });
    expect(() => graphNodeLabelAdd.input.parse({ nodeId: "n1", labels: ["bad label"] })).toThrow();
    expect(() => graphNodeLabelAdd.input.parse({ nodeId: "n1", labels: [] })).toThrow();
  });

  it("contracts register with the expected names and agent surface", () => {
    expect(graphNodeLabelAdd.name).toBe("graph.node_label.add");
    expect(graphNodeLabelRemove.name).toBe("graph.node_label.remove");
    expect(graphNodeLabelsGet.name).toBe("graph.node_label.get");
    expect(graphNodeLabelAdd.surfaces).toContain("agent");
  });

  it("label.add output carries the resulting label set + added delta", () => {
    expect(
      graphNodeLabelAdd.output.parse({ nodeId: "n1", labels: ["Billing", "Payment"], added: ["Billing"] }),
    ).toBeTruthy();
  });
});
