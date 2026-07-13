/**
 * tree-utils.ts — pure, dependency-light helpers for editing a nested
 * ConditionNode tree by id, plus stable "1 AND (2 OR 3)" leaf numbering.
 *
 * The builder is a controlled component: every edit produces a NEW tree (never
 * mutates in place) so React re-renders and `onChange` emits a fresh value.
 */
import type {
  ConditionNode,
  ConditionGroup,
  ConditionLeaf,
} from "@oxagen/oxagen/trigger-conditions";

/** Replace the node with the matching id, returning a new tree. */
export function updateNodeById(
  root: ConditionNode,
  id: string,
  updater: (node: ConditionNode) => ConditionNode,
): ConditionNode {
  if (root.id === id) return updater(root);
  if (root.kind !== "group") return root;
  return {
    ...root,
    children: root.children.map((child) => updateNodeById(child, id, updater)),
  };
}

/** Remove the node with the matching id from the tree (root is never removed). */
export function removeNodeById(root: ConditionNode, id: string): ConditionNode {
  if (root.kind !== "group") return root;
  return {
    ...root,
    children: root.children
      .filter((child) => child.id !== id)
      .map((child) => removeNodeById(child, id)),
  };
}

/** Append a child to the group with the matching id, returning a new tree. */
export function addChildToGroup(
  root: ConditionNode,
  groupId: string,
  child: ConditionNode,
): ConditionNode {
  return updateNodeById(root, groupId, (node) => {
    if (node.kind !== "group") return node;
    return { ...node, children: [...node.children, child] };
  });
}

/**
 * Assign each LEAF a stable, 1-based display number via an in-order (depth-first)
 * walk, keyed by the leaf's stable id. This is what makes the boolean logic read
 * like the user's "1 AND (2 OR 3)".
 */
export function numberLeaves(root: ConditionNode): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  const walk = (node: ConditionNode): void => {
    if (node.kind === "group") {
      node.children.forEach(walk);
      return;
    }
    n += 1;
    numbers.set(node.id, n);
  };
  walk(root);
  return numbers;
}

/** Depth of a node within `root` (root itself is depth 1); -1 if not found. */
export function depthOf(root: ConditionNode, id: string, depth = 1): number {
  if (root.id === id) return depth;
  if (root.kind !== "group") return -1;
  for (const child of root.children) {
    const found = depthOf(child, id, depth + 1);
    if (found !== -1) return found;
  }
  return -1;
}

export type { ConditionNode, ConditionGroup, ConditionLeaf };
