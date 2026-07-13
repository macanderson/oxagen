"use client";
/**
 * condition-builder.tsx — the reusable, schema-driven nested boolean condition
 * builder. Renders a root AND/OR group whose children are leaf rows or nested
 * groups (`1 AND (2 OR 3)`), with property/operator/value pickers sourced from
 * the watched entity label's schema properties.
 *
 * Pure controlled component: `value` in, `onChange(next)` out. No data fetching
 * — the caller passes the selected label's `properties`. When `disabled` (e.g.
 * the workspace has no schema), the whole tree is read-only.
 *
 *   <ConditionBuilder value={tree} onChange={setTree} properties={props} />
 */
import * as React from "react";
import {
  type ConditionNode,
  type ConditionGroup,
} from "@oxagen/oxagen/trigger-conditions";
import type { PropertyItem } from "@/components/knowledge/schema-builder/types";
import { ConditionGroupView } from "./condition-group";
import { numberLeaves } from "./tree-utils";

export interface ConditionBuilderProps {
  /**
   * The current condition tree. A bare leaf is wrapped in an AND group so the
   * root is always a group the user can add siblings to.
   */
  value: ConditionNode;
  onChange: (next: ConditionNode) => void;
  /** Properties of the currently-selected entity label (drives the pickers). */
  properties: PropertyItem[];
  disabled?: boolean;
}

/** Ensure the root is always a group so the combinator toggle has a home. */
function asRootGroup(node: ConditionNode): ConditionGroup {
  if (node.kind === "group") return node;
  return { kind: "group", id: "root", combinator: "and", children: [node] };
}

export function ConditionBuilder({
  value,
  onChange,
  properties,
  disabled,
}: ConditionBuilderProps): React.ReactElement {
  const root = React.useMemo(() => asRootGroup(value), [value]);
  const leafNumbers = React.useMemo(() => numberLeaves(root), [root]);

  return (
    <div data-testid="condition-builder">
      <ConditionGroupView
        group={root}
        depth={1}
        properties={properties}
        leafNumbers={leafNumbers}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
