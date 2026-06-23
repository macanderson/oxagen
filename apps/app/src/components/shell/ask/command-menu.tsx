"use client";
/**
 * CommandMenu — Cmd+K overlay.
 *
 * A Radix Dialog with WAI-ARIA combobox keyboard navigation.
 *
 * Sections (in render order):
 *   Quick Actions — prompt templates applicable to the current page (OXA-1769)
 *   Navigate      — all nav targets from enumerateNavTargets, filtered by query
 *   Recent        — last-5 queries from localStorage
 *   Ask           — free-text "Ask Oxagen" fallback
 *
 * Keyboard navigation:
 *   ArrowDown / ArrowUp  — move active item
 *   Enter                — activate the focused item
 *   Escape               — close
 *
 * The active item is tracked by index across all rendered items.
 */

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { Search, ArrowRight, Clock, Navigation, Sparkles, Zap, PlusCircle, ScanSearch, Settings, MessageSquare, BarChart2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import { enumerateNavTargets } from "@/lib/sidebar";
import { classifyIntent } from "@/lib/command-menu/intent-router";
import { useRecent } from "@/lib/command-menu/use-recent";
import type { ScopeContext } from "@/lib/scope";
import { getApplicableTemplates, renderTemplate, resolveVariables } from "@oxagen/prompt-templates";
import type { PromptTemplate } from "@oxagen/prompt-templates";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface CommandMenuProps {
  ctx: ScopeContext;
}

type CommandItem =
  | { type: "navigate"; label: string; href: string }
  | { type: "recent"; label: string }
  | { type: "quick-action"; label: string; template: PromptTemplate }
  | { type: "ask"; label: string };

/** Map from template category to a Lucide icon component. */
function categoryIcon(category: PromptTemplate["category"]): React.ReactNode {
  switch (category) {
    case "create": return <PlusCircle className="h-4 w-4" aria-hidden="true" />;
    case "investigate": return <ScanSearch className="h-4 w-4" aria-hidden="true" />;
    case "configure": return <Settings className="h-4 w-4" aria-hidden="true" />;
    case "communicate": return <MessageSquare className="h-4 w-4" aria-hidden="true" />;
    case "analyze": return <BarChart2 className="h-4 w-4" aria-hidden="true" />;
    default: return <Zap className="h-4 w-4" aria-hidden="true" />;
  }
}

export function CommandMenu({ ctx }: CommandMenuProps) {
  const router = useRouter();
  const pathname = usePathname();
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

  // Quick Actions — applicable prompt templates for the current page context.
  // Only shown when input is empty (templates don't need to be searched; they
  // are already pre-filtered by route/capability).
  const quickActions = React.useMemo(() => {
    if (query.trim()) return [];
    // Build a minimal page context from available runtime data.
    const currentPathname = pathname ?? `/${ctx.orgSlug ?? ""}/${ctx.workspaceSlug ?? ""}`;
    // Extract route params from the pathname by comparing it to known segment counts.
    // We pass an empty routeParams; templates that need specific route params will
    // be filtered out unless those params can be inferred. The page entity from
    // PageContext is passed for page.* resolver templates.
    const pageEntity = pageCtx.entity
      ? {
          kind: pageCtx.entity.kind,
          id: pageCtx.entity.id,
          label: pageCtx.entity.label,
          summary: pageCtx.entity.summary,
        }
      : undefined;

    // Parse routeParams from the current pathname against each template's
    // routePattern. We attempt a best-effort extraction without the full
    // router; templates with required params that can't be extracted are
    // filtered out by getApplicableTemplates.
    const routeParams = extractRouteParams(currentPathname);

    return getApplicableTemplates({
      pathname: currentPathname,
      routeParams,
      queryParams: {},
      pageEntity,
      capabilities: [], // TODO: wire real user capabilities (OXA-1773)
      locale: "en",
    });
  }, [query, pathname, ctx.orgSlug, ctx.workspaceSlug, pageCtx.entity]);

  const items: CommandItem[] = React.useMemo(() => {
    const result: CommandItem[] = [];
    for (const t of quickActions) {
      result.push({ type: "quick-action", label: t.title, template: t });
    }
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
  }, [quickActions, filteredTargets, showRecent, recent, query]);

  // Declared before handleKeyDown so it can be used in the callback dep array.
  const activateItem = React.useCallback(
    (item: CommandItem) => {
      if (item.type === "navigate") {
        pageCtx.closeCommand();
        router.push(item.href);
      } else if (item.type === "quick-action") {
        // Render the template against the current page context and open the
        // Ask Drawer with the rendered prompt pre-filled.
        const template = item.template;
        const currentPathname = pathname ?? `/${ctx.orgSlug ?? ""}/${ctx.workspaceSlug ?? ""}`;
        const routeParams = extractRouteParams(currentPathname);
        const pageEntity = pageCtx.entity
          ? {
              kind: pageCtx.entity.kind,
              id: pageCtx.entity.id,
              label: pageCtx.entity.label,
              summary: pageCtx.entity.summary,
            }
          : undefined;
        const { resolved } = resolveVariables(template.variables, {
          routeParams,
          queryParams: {},
          pageEntity,
        });
        const { rendered } = renderTemplate(template.body, resolved);
        pageCtx.closeCommand();
        pageCtx.openAskWithText(rendered, template.autoSubmit);
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
    [ctx, pageCtx, pathname, pushRecent, query, router],
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
      <DialogPopup
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
          {/* Quick Actions section — shown when empty query and templates match current route */}
          {quickActions.length > 0 && (
            <CommandSection label="Quick Actions">
              {quickActions.map((template, i) => (
                <CommandItemRow
                  key={template.id}
                  id={`cmd-item-${i}`}
                  label={template.title}
                  icon={categoryIcon(template.category)}
                  active={clampedActiveIndex === i}
                  onMouseEnter={() => setClampedActiveIndex(i)}
                  onSelect={() => void activateItem({ type: "quick-action", label: template.title, template })}
                  secondary={template.description}
                  trailing={template.shortcut ? (
                    <kbd className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
                      {template.shortcut}
                    </kbd>
                  ) : undefined}
                />
              ))}
            </CommandSection>
          )}

          {/* Navigate section */}
          {filteredTargets.length > 0 && (
            <CommandSection label="Navigate">
              {filteredTargets.map((target, i) => {
                const globalIdx = quickActions.length + i;
                return (
                  <CommandItemRow
                    key={target.href}
                    id={`cmd-item-${globalIdx}`}
                    label={target.label}
                    icon={<Navigation className="h-4 w-4" aria-hidden="true" />}
                    active={clampedActiveIndex === globalIdx}
                    onMouseEnter={() => setClampedActiveIndex(globalIdx)}
                    onSelect={() => void activateItem({ type: "navigate", label: target.label, href: target.href })}
                    trailing={<ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />}
                  />
                );
              })}
            </CommandSection>
          )}

          {/* Recent section */}
          {showRecent && (
            <CommandSection label="Recent">
              {recent.map((entry, i) => {
                const globalIdx = quickActions.length + filteredTargets.length + i;
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
      </DialogPopup>
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
  secondary,
  onMouseEnter,
  onSelect,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  trailing?: React.ReactNode;
  /** Optional one-line secondary description shown below the label. */
  secondary?: string;
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
      <span className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {secondary && (
          <span className={cn("block truncate text-[11px]", active ? "text-accent-foreground/70" : "text-muted-foreground/50")}>
            {secondary}
          </span>
        )}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route param extraction
// ---------------------------------------------------------------------------

/**
 * Best-effort extraction of route params from a pathname.
 *
 * Splits the pathname into segments and returns a map keyed by common param
 * names inferred from position. This is intentionally simple — templates that
 * require specific params (e.g. runId) will only match on detail pages where
 * those params are present and the page entity is registered via
 * useRegisterPageEntity.
 *
 * A more complete implementation would use the Next.js router's `params` map
 * (available only in RSC), but the Command Menu is a client component. This
 * approach is sufficient because:
 *   1. Templates with required params filter themselves out when the param
 *      can't be resolved (getApplicableTemplates returns empty for those).
 *   2. For detail pages, the page entity registered via useRegisterPageEntity
 *      carries the id via the `page.*` resolver, not `param.*`.
 */
function extractRouteParams(pathname: string): Record<string, string> {
  const segments = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  // Convention-based extraction for common Oxagen route shapes:
  //   0: orgSlug, 1: workspaceSlug, 2: section, 3: subsection, 4: entityId
  //
  // Use the 5th segment (index 4) as a generic entity id, mapped to all
  // common param names so templates using different names match the same
  // positional slot.
  if (segments.length >= 5) {
    const id = segments[4];
    if (id) {
      params.runId = id;
      params.triggerId = id;
      params.eventId = id;
      params.playbookId = id;
    }
  }
  return params;
}
