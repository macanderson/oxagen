"use client";

/**
 * list-toolbar.tsx — search + sort + CSV-export bar for list/table pages.
 *
 * Purely presentational — no state of its own. Pair it with
 * `useListControls` (`@/lib/lists/use-list-controls`):
 *
 *   const controls = useListControls(rows, { searchKeys: ["name"], sortOptions });
 *   <ListToolbar
 *     query={controls.query}
 *     onQueryChange={controls.setQuery}
 *     searchPlaceholder="Search agents…"
 *     sortOptions={sortOptions}
 *     sortId={controls.sortId}
 *     onSortChange={controls.setSortId}
 *     onExport={() => downloadCsv("agents.csv", toCsv(columns, controls.allFilteredRows))}
 *   >
 *     <Button size="sm" render={<Link href={newAgentHref} />}>New agent</Button>
 *   </ListToolbar>
 */

import * as React from "react";
import { Search, Download } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Display-only subset of `ListSortOption` — the toolbar never needs `compare`. */
export interface ListToolbarSortOption {
  id: string;
  label: string;
}

export interface ListToolbarProps {
  /** Current search query — from `useListControls().query`. */
  query: string;
  /** Called with the next query on every keystroke — pass `useListControls().setQuery`. */
  onQueryChange: (query: string) => void;
  /** Search input placeholder. Defaults to `"Search…"`. */
  searchPlaceholder?: string;
  /** Accessible label for the search input. Defaults to `searchPlaceholder`. */
  searchLabel?: string;
  /**
   * Available sort options. The sort `Select` renders ONLY when there is
   * more than one option — a single (or absent) option gives the user
   * nothing to choose between, so the control is omitted rather than shown
   * disabled.
   */
  sortOptions?: ListToolbarSortOption[];
  /** Current sort id — from `useListControls().sortId`. */
  sortId?: string;
  /** Called with the next sort id — pass `useListControls().setSortId`. */
  onSortChange?: (sortId: string) => void;
  /** Invoked when "Export" is clicked — build the CSV string and call `downloadCsv`. */
  onExport: () => void;
  /** Export button label. Defaults to `"Export"`. */
  exportLabel?: string;
  /** Extra actions rendered before the Export button (e.g. a "New item" button). */
  children?: React.ReactNode;
  className?: string;
}

export function ListToolbar({
  query,
  onQueryChange,
  searchPlaceholder = "Search…",
  searchLabel,
  sortOptions,
  sortId,
  onSortChange,
  onExport,
  exportLabel = "Export",
  children,
  className,
}: ListToolbarProps) {
  const showSort = Boolean(
    sortOptions && sortOptions.length > 1 && onSortChange,
  );

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-testid="list-toolbar"
    >
      <div className="relative w-full sm:w-64">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchLabel ?? searchPlaceholder}
          className="pl-8"
        />
      </div>

      {showSort && (
        <Select value={sortId} onValueChange={(v) => v && onSortChange?.(v)}>
          <SelectTrigger
            size="sm"
            className="w-40 shrink-0"
            aria-label="Sort by"
          >
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectPopup>
            {sortOptions?.map((opt) => (
              <SelectItem key={opt.id} value={opt.id}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}

      <div className="flex items-center gap-2 sm:ml-auto">
        {children}
        <Button
          type="button"
          variant="outline"
          size="sm"
          startIcon={<Download aria-hidden="true" />}
          onClick={onExport}
        >
          {exportLabel}
        </Button>
      </div>
    </div>
  );
}
