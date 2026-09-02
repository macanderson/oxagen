import { describe, expect, it } from "vitest";
import { ontologyQuery } from "./ontology.query";

describe("ontology.query contract", () => {
  it("is a read-only multi-hop traversal on api/mcp/agent/cli", () => {
    expect(ontologyQuery.name).toBe("query_ontology");
    for (const s of ["api", "mcp", "agent", "cli"]) {
      expect(ontologyQuery.surfaces).toContain(s);
    }
    expect(ontologyQuery.defaultRoles.workspace.Viewer).toBe("allow");
  });

  it("defaults direction to 'out', maxDepth to 2, limit to 100", () => {
    const parsed = ontologyQuery.input.parse({ startNodeId: "n_1" });
    expect(parsed.direction).toBe("out");
    expect(parsed.maxDepth).toBe(2);
    expect(parsed.limit).toBe(100);
  });

  it("bounds maxDepth to 1–5", () => {
    expect(() =>
      ontologyQuery.input.parse({ startNodeId: "n_1", maxDepth: 6 }),
    ).toThrow();
    expect(() =>
      ontologyQuery.input.parse({ startNodeId: "n_1", maxDepth: 0 }),
    ).toThrow();
  });

  it("allows a null startNode in the output (node not found)", () => {
    const parsed = ontologyQuery.output.parse({
      startNode: null,
      nodes: [],
      edges: [],
      truncated: false,
    });
    expect(parsed.startNode).toBeNull();
  });
});
