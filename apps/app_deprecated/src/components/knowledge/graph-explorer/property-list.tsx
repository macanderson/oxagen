/**
 * property-list.tsx — type-aware key/value renderer for node/edge properties.
 *
 * Each value is formatted by its detected kind (date, number, url, boolean,
 * array, object, string) via the pure `format` helpers. URLs render as links;
 * everything else is plain text. Used by the detail panels and the edge hover
 * popover.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { detectKind, formatPropertyValue, humanizeKey } from "./lib/format";

export interface PropertyListProps {
  properties: Record<string, unknown>;
  /** Keys to omit (already shown elsewhere, e.g. displayName). */
  omit?: string[];
  className?: string;
  /** Compact density for the hover popover. */
  dense?: boolean;
}

export function PropertyList({
  properties,
  omit,
  className,
  dense,
}: PropertyListProps) {
  const omitSet = React.useMemo(() => new Set(omit ?? []), [omit]);
  const entries = React.useMemo(
    () =>
      Object.entries(properties)
        .filter(([key]) => !omitSet.has(key))
        .sort((a, b) => a[0].localeCompare(b[0])),
    [properties, omitSet],
  );

  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No properties.</p>;
  }

  return (
    <dl
      className={cn(
        "grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)]",
        dense ? "gap-x-3 gap-y-1" : "gap-x-4 gap-y-2",
        className,
      )}
    >
      {entries.map(([key, value]) => (
        <React.Fragment key={key}>
          <dt
            className={cn(
              "truncate text-muted-foreground",
              dense ? "text-[11px]" : "text-xs",
            )}
            title={humanizeKey(key)}
          >
            {humanizeKey(key)}
          </dt>
          <dd
            className={cn(
              "min-w-0 break-words text-foreground",
              dense ? "text-[11px]" : "text-xs",
            )}
          >
            <PropertyValue value={value} />
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function PropertyValue({ value }: { value: unknown }) {
  const kind = detectKind(value);
  const formatted = formatPropertyValue(value);
  if (kind === "url") {
    return (
      <a
        href={String(value)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline-offset-2 hover:underline break-all"
      >
        {formatted}
      </a>
    );
  }
  if (kind === "null") {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span>{formatted}</span>;
}
