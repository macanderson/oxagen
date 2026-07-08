import { describe, expect, it } from "vitest";
import { graphNodeGet } from "./graph.node.get";
import { getCapability } from "../registry";

describe("graph.node.get capability", () => {
  // ── input: nodeId ─────────────────────────────────────────────────────────

  it("accepts a valid nodeId string", () => {
    const parsed = graphNodeGet.input.parse({ nodeId: "kn_abc123" });
    expect(parsed.nodeId).toBe("kn_abc123");
  });

  it("rejects a missing nodeId", () => {
    expect(() => graphNodeGet.input.parse({})).toThrow();
  });

  it("rejects a non-string nodeId", () => {
    expect(() => graphNodeGet.input.parse({ nodeId: 42 })).toThrow();
  });

  it("rejects null as nodeId", () => {
    expect(() => graphNodeGet.input.parse({ nodeId: null })).toThrow();
  });

  // ── output: found node ────────────────────────────────────────────────────

  it("parses a fully populated node", () => {
    const parsed = graphNodeGet.output.parse({
      node: {
        nodeId: "kn_abc",
        label: "Person",
        displayName: "Alice",
        description: "A developer",
        properties: { org: "Acme" },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-06-01T00:00:00.000Z",
      },
    });
    expect(parsed.node?.nodeId).toBe("kn_abc");
    expect(parsed.node?.label).toBe("Person");
    expect(parsed.node?.displayName).toBe("Alice");
    expect(parsed.node?.description).toBe("A developer");
    expect(parsed.node?.properties).toEqual({ org: "Acme" });
    expect(parsed.node?.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(parsed.node?.updatedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("parses a node with null description and null properties", () => {
    const parsed = graphNodeGet.output.parse({
      node: {
        nodeId: "kn_abc",
        label: "Topic",
        displayName: "AI",
        description: null,
        properties: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: null,
      },
    });
    expect(parsed.node?.description).toBeNull();
    expect(parsed.node?.properties).toBeNull();
    expect(parsed.node?.updatedAt).toBeNull();
  });

  it("parses output with node=null (not found)", () => {
    const parsed = graphNodeGet.output.parse({ node: null });
    expect(parsed.node).toBeNull();
  });

  it("rejects output missing node field", () => {
    expect(() => graphNodeGet.output.parse({})).toThrow();
  });

  it("rejects a node missing the required createdAt field", () => {
    expect(() =>
      graphNodeGet.output.parse({
        node: {
          nodeId: "kn_abc",
          label: "Person",
          displayName: "Alice",
          description: null,
          properties: null,
          updatedAt: null,
          // createdAt missing
        },
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("get_node")).toBe(graphNodeGet);
  });
});
