"use client";
/**
 * condition-group.tsx — a boolean group: an AND/OR combinator toggle plus a
 * list of children (leaf rows or nested groups), with "+ Add condition" and
 * "+ Add group" buttons and per-child remove.
 *
 * Recursive: a group renders nested groups by recursing into itself. Nesting is
 * capped at MAX_CONDITION_DEPTH — the "+ Add group" button hides once the group
 * sits at the last allowed depth.
 *
 * Pure & controlled — every edit calls onChange with a fresh group node.
 */
import * as React from "react";
import { Plus, X } from "lucide-react";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
  emptyConditionLeaf,
  emptyConditionGroup,
  MAX_CONDITION_DEPTH,
  type ConditionGroup,
  type ConditionNode,
} from "@oxagen/oxagen/trigger-conditions";
import type { PropertyItem } from "@/components/knowledge/schema-builder/types";
import { ConditionLeafRow } from "./condition-leaf-row";

interface ConditionGroupViewProps {
  group: ConditionGroup;
  /** Depth of this group within the tree (root = 1). */
  depth: number;
  /** Properties of the currently-selected entity label. */
  properties: PropertyItem[];
  /** Stable 1-based leaf numbers for the whole tree, keyed by leaf id. */
  leafNumbers: Map<string, number>;
  onChange: (next: ConditionGroup) => void;
  /** Remove this whole group (undefined for the root, which can't be removed). */
  onRemove?: () => void;
  disabled?: boolean;
}

export function ConditionGroupView({
  group,
  depth,
  properties,
  leafNumbers,
  onChange,
  onRemove,
  disabled,
}: ConditionGroupViewProps): React.ReactElement {
  const isRoot = depth === 1;
  const canNest = depth < MAX_CONDITION_DEPTH;

  const setCombinator = (combinator: string): void => {
    if (combinator === "and" || combinator === "or") {
      onChange({ ...group, combinator });
    }
  };

  const replaceChild = (index: number, next: ConditionNode): void => {
    onChange({
      ...group,
      children: group.children.map((c, i) => (i === index ? next : c)),
    });
  };

  const removeChild = (index: number): void => {
    onChange({
      ...group,
      children: group.children.filter((_, i) => i !== index),
    });
  };

  const addCondition = (): void => {
    onChange({ ...group, children: [...group.children, emptyConditionLeaf()] });
  };

  const addGroup = (): void => {
    onChange({
      ...group,
      children: [...group.children, emptyConditionGroup("and")],
    });
  };

  return (
    <div
      className={
        isRoot
          ? "space-y-3"
          : "space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3"
      }
      data-testid={`condition-group-${group.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SegmentedControl
            value={group.combinator}
            onValueChange={setCombinator}
            aria-label="Combinator"
            data-testid={`group-combinator-${group.id}`}
          >
            <SegmentedControlItem value="and" disabled={disabled}>
              AND
            </SegmentedControlItem>
            <SegmentedControlItem value="or" disabled={disabled}>
              OR
            </SegmentedControlItem>
          </SegmentedControl>
          {!isRoot && (
            <span className="text-xs text-muted-foreground">group</span>
          )}
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
            aria-label="Remove group"
            data-testid={`group-remove-${group.id}`}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {group.children.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No conditions yet. Add a condition to start matching.
        </p>
      )}

      <div className="space-y-2">
        {group.children.map((child, index) =>
          child.kind === "group" ? (
            <ConditionGroupView
              key={child.id}
              group={child}
              depth={depth + 1}
              properties={properties}
              leafNumbers={leafNumbers}
              onChange={(next) => replaceChild(index, next)}
              onRemove={() => removeChild(index)}
              disabled={disabled}
            />
          ) : (
            <ConditionLeafRow
              key={child.id}
              leaf={child}
              index={leafNumbers.get(child.id) ?? index + 1}
              properties={properties}
              onChange={(next) => replaceChild(index, next)}
              onRemove={() => removeChild(index)}
              disabled={disabled}
            />
          ),
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={addCondition}
          disabled={disabled}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          data-testid={`group-add-condition-${group.id}`}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add condition
        </button>
        {canNest && (
          <button
            type="button"
            onClick={addGroup}
            disabled={disabled}
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            data-testid={`group-add-group-${group.id}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add group
          </button>
        )}
      </div>
    </div>
  );
}
