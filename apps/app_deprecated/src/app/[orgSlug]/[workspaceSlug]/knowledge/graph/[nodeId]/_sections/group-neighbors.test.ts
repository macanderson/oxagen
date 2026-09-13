/**
 * group-neighbors.test.ts — grouping/sorting coverage for the Neighbors
 * section's pure helper.
 */
import { describe, it, expect } from "vitest";
import { groupNeighborsByType, type NeighborEntry } from "./group-neighbors";

function neighbor(overrides: Partial<NeighborEntry> = {}): NeighborEntry {
  return {
    nodeId: "kn_1",
    label: "Feature",
    displayName: "Billing",
    description: null,
    edgeType: "RELATES_TO",
    direction: "out",
    validFrom: null,
    validTo: null,
    recordedAt: null,
    invalidatedAt: null,
    ...overrides,
  };
}

describe("groupNeighborsByType", () => {
  it("returns an empty array for no neighbors", () => {
    expect(groupNeighborsByType([])).toEqual([]);
  });

  it("groups neighbors sharing the same edgeType + direction together", () => {
    const a = neighbor({ nodeId: "kn_a" });
    const b = neighbor({ nodeId: "kn_b" });
    const groups = groupNeighborsByType([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "RELATES_TO:out",
      edgeType: "RELATES_TO",
      direction: "out",
    });
    expect(groups[0]?.neighbors).toEqual([a, b]);
  });

  it("keeps the same edgeType but different direction in separate groups", () => {
    const out = neighbor({ nodeId: "kn_out", direction: "out" });
    const inbound = neighbor({ nodeId: "kn_in", direction: "in" });
    const groups = groupNeighborsByType([out, inbound]);
    expect(groups.map((g) => g.key).sort()).toEqual([
      "RELATES_TO:in",
      "RELATES_TO:out",
    ]);
  });

  it("separates different relationship types into their own groups", () => {
    const groups = groupNeighborsByType([
      neighbor({ nodeId: "kn_1", edgeType: "AUTHORED" }),
      neighbor({ nodeId: "kn_2", edgeType: "WORKS_AT" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("sorts groups by edgeType then direction for deterministic rendering", () => {
    const groups = groupNeighborsByType([
      neighbor({ nodeId: "kn_1", edgeType: "WORKS_AT", direction: "out" }),
      neighbor({ nodeId: "kn_2", edgeType: "AUTHORED", direction: "in" }),
      neighbor({ nodeId: "kn_3", edgeType: "AUTHORED", direction: "out" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      "AUTHORED:in",
      "AUTHORED:out",
      "WORKS_AT:out",
    ]);
  });

  it("preserves the incoming order of neighbors within a group", () => {
    const first = neighbor({ nodeId: "kn_1", displayName: "Alpha" });
    const second = neighbor({ nodeId: "kn_2", displayName: "Beta" });
    const groups = groupNeighborsByType([first, second]);
    expect(groups[0]?.neighbors.map((n) => n.displayName)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});
