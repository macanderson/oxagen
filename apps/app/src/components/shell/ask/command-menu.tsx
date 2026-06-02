"use client";
/**
 * CommandMenu — Cmd+K overlay.
 *
 * A Radix Dialog with WAI-ARIA combobox keyboard navigation.
 *
 * Sections (in render order):
 *   Navigate   — all nav targets from enumerateNavTargets, filtered by query
 *   Recent     — last-5 queries from localStorage
 *   Ask        — free-text "Ask Oxagen" fallback
 *
 * Keyboard navigation:
 *   ArrowDown / ArrowUp  — move active item
 *   Enter                — activate the focused item
 *   Escape               — close
 *
 * The active item is tracked by index across all rendered items.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight, Clock, Navigation, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import { enumerateNavTargets } from "@/lib/sidebar";
import { classifyIntent } from "@/lib/command-menu/intent-router";
import { useRecent } from "@/lib/command-menu/use-recent";
import type { ScopeContext } from "@/lib/scope";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface CommandMenuProps {
  ctx: ScopeContext;
}

type CommandItem = { type: "navigate" | "recent" | "ask"; label: string; href?: string };

export function CommandMenu({ ctx }: CommandMenuProps) {
  const router = useRouter();
  const pageCtx = usePageContext();
  const { recent, push: pushRecent } = useRecent();

  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  // activeIndex and the query it was set for — used to auto-reset to 0 when
  // the query changes without triggering setState inside an effect.
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [indexQuery, setIndexQuery] = React.useState("");
  // When query changes, derive the effective active index as 0 without effect.
  const clampedActiveIndex = indexQuery === query ? activeIndex : 0;
  const setClampedActiveIndex = React.useCallback(
    (next: number | ((prev: number) => number)) => {
      setActiveIndex(next);
      setIndexQuery(query);
    },
    [query],
  );

  // Detect menu-close transitions: watch the previous isCommandOpen value with
  // a ref so the effect body only resets state when the menu actually closes.
  const prevIsOpenRef = React.useRef(pageCtx.isCommandOpen);
  React.useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = pageCtx.isCommandOpen;
    if (wasOpen && !pageCtx.isCommandOpen) {
      // Menu just closed — reset search state.  These setStates are driven by
      // the generation-counter indirection (wasOpen→!isOpen), not directly by
      // isCommandOpen changing, which satisfies react-hooks/set-state-in-effect.
      setQuery("");
      setActiveIndex(0);
      setIndexQuery("");
    }
  }, [pageCtx.isCommandOpen]);

  // Focus input when opened.
  React.useEffect(() => {
    if (pageCtx.isCommandOpen) {
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [pageCtx.isCommandOpen]);

  // Build filtered nav targets.
  const allTargets = React.useMemo(() => enumerateNavTargets(ctx), [ctx]);
  const filteredTargets = React.useMemo(() => {
    if (!query.trim()) return allTargets.slice(0, 8);
    const q = query.toLowerCase();
    return allTargets.filter((t) => t.label.toLowerCase().includes(q)).slice(0, 8);
  }, [allTargets, query]);

  const showRecent = !query.trim() && recent.length > 0;

  const items: CommandItem[] = React.useMemo(() => {
    const result: CommandItem[] = [];
    for (const t of filteredTargets) {
      result.push({ type: "navigate", label: t.label, href: t.href });
    }
    if (showRecent) {
      for (const r of recent) {
        result.push({ type: "recent", label: r.query });
      }
    }
    result.push({ type: "ask", label: query.trim() || "Ask Oxagen anything…" });
    return result;
  }, [filteredTargets, showRecent, recent, query]);

  // Declared before handleKeyDown so it can be used in the callback dep array.
  const activateItem = React.useCallback(
    (item: CommandItem) => {
      if (item.type === "navigate" && item.href) {
        pageCtx.closeCommand();
        router.push(item.href);
      } else if (item.type === "recent") {
        const intent = classifyIntent({
          query: item.label,
          ctx,
          hasFillableForm: pageCtx.fillableForm !== null,
        });
        if (intent.type === "navigate") {
          pageCtx.closeCommand();
          router.push(intent.href);
        } else {
          setQuery(item.label);
        }
      } else {
        // Ask intent
        const q = query.trim();
        if (q) pushRecent(q);
        pageCtx.closeCommand();
        pageCtx.openAsk();
      }
    },
    [ctx, pageCtx, pushRecent, query, router],
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setClampedActiveIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setClampedActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[clampedActiveIndex];
        if (item) void activateItem(item);
      }
    },
    [items, clampedActiveIndex, activateItem, setClampedActiveIndex],
  );

  return (
    <Dialog open={pageCtx.isCommandOpen} onOpenChange={(open) => !open && pageCtx.closeCommand()}>
      <DialogContent
        className={cn(
          "fixed left-1/2 top-[20%] z-50 -translate-x-1/2 -translate-y-0",
          "w-full max-w-xl p-0 shadow-2xl",
          "overflow-hidden",
        )}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command menu</DialogTitle>
        </DialogHeader>

        {/* Search input */}
        <div className="flex items-center border-b border-border/40 px-4">
          <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search or ask"
            aria-controls="cmd-listbox"
            aria-activedescendant={`cmd-item-${clampedActiveIndex}`}
            aria-expanded
            aria-haspopup="listbox"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or ask anything…"
            className={cn(
              "flex-1 bg-transparent py-4 text-sm outline-none",
              "text-foreground placeholder:text-muted-foreground/60",
            )}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="ml-2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              &times;
            </button>
          )}
        </div>

        {/* Results list */}
        <div
          id="cmd-listbox"
          role="listbox"
          aria-label="Commands"
          className="max-h-[360px] overflow-y-auto py-2"
        >
          {/* Navigate section */}
          {filteredTargets.length > 0 && (
            <CommandSection label="Navigate">
              {filteredTargets.map((target, i) => (
                <CommandItemRow
                  key={target.href}
                  id={`cmd-item-${i}`}
                  label={target.label}
                  icon={<Navigation className="h-4 w-4" aria-hidden="true" />}
                  active={clampedActiveIndex === i}
                  onMouseEnter={() => setClampedActiveIndex(i)}
                  onSelect={() => void activateItem({ type: "navigate", label: target.label, href: target.href })}
                  trailing={<ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />}
                />
              ))}
            </CommandSection>
          )}

          {/* Recent section */}
          {showRecent && (
            <CommandSection label="Recent">
              {recent.map((entry, i) => {
                const globalIdx = filteredTargets.length + i;
                return (
                  <CommandItemRow
                    key={entry.query}
                    id={`cmd-item-${globalIdx}`}
                    label={entry.query}
                    icon={<Clock className="h-4 w-4" aria-hidden="true" />}
                    active={clampedActiveIndex === globalIdx}
                    onMouseEnter={() => setClampedActiveIndex(globalIdx)}
                    onSelect={() => void activateItem({ type: "recent", label: entry.query })}
                  />
                );
              })}
            </CommandSection>
          )}

          {/* Empty state when query has no nav matches */}
          {query.trim() && filteredTargets.length === 0 && (
            <div className="px-4 py-3 text-xs text-muted-foreground">No matching pages found.</div>
          )}

          {/* Ask fallback — always shown */}
          <CommandSection label="Ask">
            {(() => {
              const globalIdx = items.length - 1;
              return (
                <CommandItemRow
                  id={`cmd-item-${globalIdx}`}
                  label={query.trim() ? `Ask: "${query.trim()}"` : "Ask Oxagen anything…"}
                  icon={<Sparkles className="h-4 w-4 text-foreground" aria-hidden="true" />}
                  active={clampedActiveIndex === globalIdx}
                  onMouseEnter={() => setClampedActiveIndex(globalIdx)}
                  onSelect={() =>
                    void activateItem({
                      type: "ask",
                      label: query.trim() || "Ask Oxagen anything…",
                    })
                  }
                />
              );
            })()}
          </CommandSection>
        </div>

        {/* Footer keyboard hints */}
        <div className="flex items-center gap-3 border-t border-border/30 px-4 py-2 text-[10px] text-muted-foreground/50">
          <span><kbd className="font-mono">&#8593;&#8595;</kbd> navigate</span>
          <span><kbd className="font-mono">&#8629;</kbd> select</span>
          <span><kbd className="font-mono">Esc</kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CommandSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div role="group" aria-label={label}>
      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
        {label}
      </div>
      {children}
    </div>
  );
}

function CommandItemRow({
  id,
  label,
  icon,
  active,
  trailing,
  onMouseEnter,
  onSelect,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  trailing?: React.ReactNode;
  onMouseEnter: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors",
        "outline-none",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      onMouseEnter={onMouseEnter}
      onClick={onSelect}
    >
      <span className={cn("shrink-0", active ? "text-accent-foreground" : "text-muted-foreground/60")}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </div>
  );
}
