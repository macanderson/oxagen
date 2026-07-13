/**
 * tree-utils.test.ts — pure tree-editing + leaf-numbering helpers.
 */
import { describe, it, expect } from "vitest";
import {
  emptyConditionGroup,
  emptyConditionLeaf,
  type ConditionGroup,
  type ConditionNode,
  type ConditionLeaf,
} from "@oxagen/oxagen/trigger-conditions";
import {
  updateNodeById,
  removeNodeById,
  addChildToGroup,
  numberLeaves,
  depthOf,
} from "./tree-utils";

/** Narrow the group's child at `i` to a leaf, failing the test if it isn't. */
function leafAt(node: ConditionNode, i: number): ConditionLeaf {
  if (node.kind !== "group") throw new Error("expected a group");
  const child = node.children[i];
  if (!child || child.kind !== "condition")
    throw new Error(`expected a leaf at ${i}`);
  return child;
}

function groupAt(node: ConditionNode, i: number): ConditionGroup {
  if (node.kind !== "group") throw new Error("expected a group");
  const child = node.children[i];
  if (!child || child.kind !== "group")
    throw new Error(`expected a group at ${i}`);
  return child;
}

function fixedTree(): ConditionGroup {
  // 1 AND (2 OR 3)
  return {
    kind: "group",
    id: "root",
    combinator: "and",
    children: [
      {
        kind: "condition",
        id: "c1",
        property: "status",
        operator: "eq",
        value: "won",
      },
      {
        kind: "group",
        id: "g1",
        combinator: "or",
        children: [
          {
            kind: "condition",
            id: "c2",
            property: "priority",
            operator: "eq",
            value: "P0",
          },
          {
            kind: "condition",
            id: "c3",
            property: "label",
            operator: "eq",
            value: "blocker",
          },
        ],
      },
    ],
  };
}

describe("numberLeaves", () => {
  it("numbers leaves 1..n in depth-first order, keyed by id", () => {
    const nums = numberLeaves(fixedTree());
    expect(nums.get("c1")).toBe(1);
    expect(nums.get("c2")).toBe(2);
    expect(nums.get("c3")).toBe(3);
    // Groups are not numbered.
    expect(nums.has("g1")).toBe(false);
    expect(nums.has("root")).toBe(false);
  });
});

describe("updateNodeById", () => {
  it("replaces the matching node and returns a new tree (no mutation)", () => {
    const tree = fixedTree();
    const next = updateNodeById(tree, "c1", (n) =>
      n.kind === "condition" ? { ...n, value: "lost" } : n,
    );
    expect(next).not.toBe(tree);
    expect(leafAt(next, 0).value).toBe("lost");
    // Original untouched.
    expect(leafAt(tree, 0).value).toBe("won");
  });

  it("recurses into nested groups", () => {
    const next = updateNodeById(fixedTree(), "c3", (n) =>
      n.kind === "condition" ? { ...n, operator: "neq" } : n,
    );
    const group = groupAt(next, 1);
    expect(leafAt(group, 1).operator).toBe("neq");
  });
});

describe("removeNodeById", () => {
  it("removes a top-level child", () => {
    const next = removeNodeById(fixedTree(), "c1") as ConditionGroup;
    expect(next.children).toHaveLength(1);
    expect(next.children[0]?.id).toBe("g1");
  });

  it("removes a nested child", () => {
    const next = removeNodeById(fixedTree(), "c2") as ConditionGroup;
    const group = groupAt(next, 1);
    expect(group.children).toHaveLength(1);
    expect(group.children[0]?.id).toBe("c3");
  });
});

describe("addChildToGroup", () => {
  it("appends a child to the target group", () => {
    const leaf = emptyConditionLeaf("newprop");
    const next = addChildToGroup(fixedTree(), "g1", leaf) as ConditionGroup;
    const group = groupAt(next, 1);
    expect(group.children).toHaveLength(3);
    expect(group.children[2]?.id).toBe(leaf.id);
  });

  it("can add a nested group to the root", () => {
    const grp = emptyConditionGroup("or");
    const next = addChildToGroup(fixedTree(), "root", grp) as ConditionGroup;
    expect(next.children).toHaveLength(3);
    expect(next.children[2]?.kind).toBe("group");
  });
});

describe("depthOf", () => {
  it("returns 1 for the root and deeper for nested nodes", () => {
    const tree = fixedTree();
    expect(depthOf(tree, "root")).toBe(1);
    expect(depthOf(tree, "c1")).toBe(2);
    expect(depthOf(tree, "g1")).toBe(2);
    expect(depthOf(tree, "c2")).toBe(3);
    expect(depthOf(tree, "missing")).toBe(-1);
  });
});
