"use client";

import * as React from "react";
import type { MentionTypeInfo } from "@oxagen/ai/mentions";
import { cn } from "@/lib/utils";
import { MENTION_TYPE_META, type MentionSearchResult } from "./mention-meta";

interface MentionMenuProps {
  /** "type" = pick a reference kind; "search" = pick a result within it. */
  stage: "type" | "search";
  types: readonly MentionTypeInfo[];
  results: readonly MentionSearchResult[];
  selectedType: MentionTypeInfo | null;
  activeIndex: number;
  loading: boolean;
  query: string;
  onSelectType: (type: MentionTypeInfo) => void;
  onSelectResult: (result: MentionSearchResult) => void;
  onHoverIndex: (index: number) => void;
}

/**
 * Autocomplete overlay for composer @-mentions. Presentational only — the
 * composer owns the trigger/query/active-index state and the keyboard
 * navigation (so it can intercept Enter before the form submits), exactly
 * like SlashCommandMenu. Two stages: pick a reference TYPE, then search
 * within it (results come from search_references, scoped + filtered).
 */
export function MentionMenu({
  stage,
  types,
  results,
  selectedType,
  activeIndex,
  loading,
  query,
  onSelectType,
  onSelectResult,
  onHoverIndex,
}: MentionMenuProps) {
  return (
    <div
      role="listbox"
      aria-label="Mention references"
      className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
      data-testid="mention-menu"
    >
      {stage === "search" && selectedType ? (
        <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
          {(() => {
            const Icon = MENTION_TYPE_META[selectedType.type].icon;
            return (
              <Icon
                className={cn(
                  "size-3.5",
                  MENTION_TYPE_META[selectedType.type].iconClassName,
                )}
                aria-hidden="true"
              />
            );
          })()}
          <span className="text-xs font-medium">
            {selectedType.pluralLabel}
          </span>
          <span className="text-xs text-muted-foreground">
            — type to search
          </span>
        </div>
      ) : null}
      <ul className="max-h-64 overflow-y-auto py-1">
        {stage === "type" ? (
          types.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">
              No reference types match.
            </li>
          ) : (
            types.map((info, index) => {
              const Icon = MENTION_TYPE_META[info.type].icon;
              return (
                <li key={info.type}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    // Prevent the textarea from losing focus (and the menu from
                    // closing on blur) before onClick fires.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => onHoverIndex(index)}
                    onClick={() => onSelectType(info)}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-1.5 text-left",
                      index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                    )}
                    data-testid={`mention-type-${info.type}`}
                  >
                    <Icon
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0",
                        MENTION_TYPE_META[info.type].iconClassName,
                      )}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-xs font-medium">
                        {info.pluralLabel}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {info.summary}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })
          )
        ) : loading && results.length === 0 ? (
          <li className="px-3 py-1.5 text-xs text-muted-foreground">
            Searching…
          </li>
        ) : results.length === 0 ? (
          <li className="px-3 py-1.5 text-xs text-muted-foreground">
            {query.trim() ? "No matches." : "Type to search."}
          </li>
        ) : (
          results.map((result, index) => {
            const Icon = MENTION_TYPE_META[result.type].icon;
            return (
              <li key={`${result.type}:${result.slug}:${result.location}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => onHoverIndex(index)}
                  onClick={() => onSelectResult(result)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-1.5 text-left",
                    index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                  )}
                  data-testid={`mention-result-${index}`}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      MENTION_TYPE_META[result.type].iconClassName,
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-xs font-medium">
                      {result.label}
                    </span>
                    {result.description || result.location ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {result.description ?? result.location}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
