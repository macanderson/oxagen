/**
 * type-filter-panel.tsx — visibility controls for node labels and edge types.
 *
 * Each row is a checkbox + colour swatch + type name + in-view count. Unchecking
 * a node label removes those nodes (and their dangling edges) from every view;
 * unchecking an edge type hides those relationships. The count sits next to the
 * type name — the same row that controls its visibility — per the spec.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import type { TypeCount } from "./types";
import {
  colorForLabel,
  CONFIRMED_EDGE_COLOR,
  INFERRED_EDGE_COLOR,
} from "./lib/colors";

export interface TypeFilterPanelProps {
  nodeCounts: TypeCount[];
  edgeCounts: TypeCount[];
  hiddenNodeTypes: Set<string>;
  hiddenEdgeTypes: Set<string>;
  /** True when inferred edges are currently hidden. */
  inferredHidden: boolean;
  inferredCount: number;
  confirmedCount: number;
  onToggleNodeType: (type: string) => void;
  onToggleEdgeType: (type: string) => void;
  onToggleInferred: () => void;
  onShowAllNodeTypes: () => void;
  onHideAllNodeTypes: () => void;
}

export function TypeFilterPanel(props: TypeFilterPanelProps) {
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <section aria-labelledby="node-types-heading">
        <div className="mb-2 flex items-center justify-between">
          <h3
            id="node-types-heading"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Node types
          </h3>
          <div className="flex items-center gap-1 text-[11px]">
            <button
              type="button"
              onClick={props.onShowAllNodeTypes}
              className="text-muted-foreground hover:text-foreground"
            >
              All
            </button>
            <span className="text-border" aria-hidden="true">
              /
            </span>
            <button
              type="button"
              onClick={props.onHideAllNodeTypes}
              className="text-muted-foreground hover:text-foreground"
            >
              None
            </button>
          </div>
        </div>
        <ul className="flex flex-col gap-0.5">
          {props.nodeCounts.length === 0 && (
            <li className="text-xs text-muted-foreground">No nodes in view.</li>
          )}
          {props.nodeCounts.map((tc) => (
            <FilterRow
              key={tc.type}
              label={tc.type}
              count={tc.count}
              color={colorForLabel(tc.type)}
              checked={!props.hiddenNodeTypes.has(tc.type)}
              onToggle={() => props.onToggleNodeType(tc.type)}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="visibility-heading">
        <h3
          id="visibility-heading"
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Visibility
        </h3>
        <ul className="flex flex-col gap-0.5">
          <FilterRow
            label="Inferred edges"
            count={props.inferredCount}
            color={INFERRED_EDGE_COLOR}
            checked={!props.inferredHidden}
            onToggle={props.onToggleInferred}
            squareSwatch
          />
          <FilterRow
            label="Confirmed edges"
            count={props.confirmedCount}
            color={CONFIRMED_EDGE_COLOR}
            checked
            disabled
            onToggle={() => undefined}
            squareSwatch
          />
        </ul>
      </section>

      <section aria-labelledby="edge-types-heading">
        <h3
          id="edge-types-heading"
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Relationship types
        </h3>
        <ul className="flex flex-col gap-0.5">
          {props.edgeCounts.length === 0 && (
            <li className="text-xs text-muted-foreground">
              No relationships in view.
            </li>
          )}
          {props.edgeCounts.map((tc) => (
            <FilterRow
              key={tc.type}
              label={tc.type}
              count={tc.count}
              checked={!props.hiddenEdgeTypes.has(tc.type)}
              onToggle={() => props.onToggleEdgeType(tc.type)}
              squareSwatch
              color={CONFIRMED_EDGE_COLOR}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

interface FilterRowProps {
  label: string;
  count: number;
  color: string;
  checked: boolean;
  disabled?: boolean;
  squareSwatch?: boolean;
  onToggle: () => void;
}

function FilterRow({
  label,
  count,
  color,
  checked,
  disabled,
  squareSwatch,
  onToggle,
}: FilterRowProps) {
  return (
    <li>
      <label
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted/60",
          disabled && "cursor-default opacity-70 hover:bg-transparent",
        )}
      >
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={() => onToggle()}
        />
        <span
          className={cn(
            "size-2.5 shrink-0",
            squareSwatch ? "rounded-[2px]" : "rounded-full",
          )}
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-foreground" title={label}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
          {count.toLocaleString()}
        </span>
      </label>
    </li>
  );
}
