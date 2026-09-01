"use client";
/**
 * CommandMenu — Cmd+K overlay.
 *
 * A Radix Dialog with WAI-ARIA combobox keyboard navigation.
 *
 * Sections (in render order):
 *   Suggested for this page — LLM suggestions; above Quick Actions when no query
 *   Quick Actions           — prompt templates applicable to current page
 *   Navigate                — all nav targets from enumerateNavTargets, filtered by query
 *   Search results          — entity search replacing Quick Actions + Navigate when query
 *                             matches an entity prefix
 *   Recent                  — last-5 queries from localStorage
 *   Ask                     — free-text "Ask Oxagen" fallback
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
import {
  Search,
  ArrowRight,
  Clock,
  Navigation,
  Sparkles,
  Zap,
  PlusCircle,
  ScanSearch,
  Settings,
  MessageSquare,
  BarChart2,
  User,
  BookOpen,
  Zap as TriggerIcon,
  CalendarClock,
  Bot,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import { enumerateNavTargets } from "@/lib/sidebar";
import { classifyIntent } from "@/lib/command-menu/intent-router";
import { useRecent } from "@/lib/command-menu/use-recent";
import { matchEntityPrefix } from "./entity-prefix";
import type { EntityKind } from "./entity-prefix";
import { useSuggestions } from "./use-suggestions";
import type { SuggestionItem } from "./use-suggestions";
import type { ScopeContext } from "@/lib/scope";
import {
  getApplicableTemplates,
  renderTemplate,
  resolveVariables,
} from "@/lib/prompt-templates";
import type { PromptTemplate } from "@/lib/prompt-templates";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface CommandMenuProps {
  ctx: ScopeContext;
}

// ── Search result row (from /api/command-menu/search) ─────────────────────────

interface SearchResultRow {
  kind: EntityKind;
  id: string;
  label: string;
  scope: string;
  contextLine: string | null;
  href: string;
}

type CommandItem =
  | { type: "navigate"; label: string; href: string }
  | { type: "recent"; label: string }
  | { type: "quick-action"; label: string; template: PromptTemplate }
  | { type: "suggestion"; label: string; category: SuggestionItem["category"] }
  | { type: "search-result"; label: string; row: SearchResultRow }
  | { type: "ask"; label: string };

/** Map from template category to a Lucide icon component. */
function categoryIcon(
  category: PromptTemplate["category"] | SuggestionItem["category"],
): React.ReactNode {
  switch (category) {
    case "create":
      return <PlusCircle className="h-4 w-4" aria-hidden="true" />;
    case "investigate":
      return <ScanSearch className="h-4 w-4" aria-hidden="true" />;
    case "configure":
      return <Settings className="h-4 w-4" aria-hidden="true" />;
    case "communicate":
      return <MessageSquare className="h-4 w-4" aria-hidden="true" />;
    case "analyze":
      return <BarChart2 className="h-4 w-4" aria-hidden="true" />;
    default:
      return <Zap className="h-4 w-4" aria-hidden="true" />;
  }
}

/** Map from entity kind to a Lucide icon for Search result rows. */
function entityKindIcon(kind: EntityKind): React.ReactNode {
  switch (kind) {
    case "run":
      return <CalendarClock className="h-4 w-4" aria-hidden="true" />;
    case "principal":
      return <User className="h-4 w-4" aria-hidden="true" />;
    case "playbook":
      return <BookOpen className="h-4 w-4" aria-hidden="true" />;
    case "trigger":
      return <TriggerIcon className="h-4 w-4" aria-hidden="true" />;
    case "event":
      return <CalendarClock className="h-4 w-4" aria-hidden="true" />;
    case "agent":
      return <Bot className="h-4 w-4" aria-hidden="true" />;
    default:
      return <Search className="h-4 w-4" aria-hidden="true" />;
  }
}

// ── Entity search hook ────────────────────────────────────────────────────────

interface UseEntitySearchResult {
  rows: SearchResultRow[];
  loading: boolean;
}

function useEntitySearch(args: {
  kind: EntityKind | undefined;
  query: string;
  orgSlug: string;
  workspaceSlug: string;
  enabled: boolean;
}): UseEntitySearchResult {
  const [rows, setRows] = React.useState<SearchResultRow[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!args.enabled) {
      setRows([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    let cancelled = false;
    const controller = new AbortController();

    fetch("/api/command-menu/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgSlug: args.orgSlug,
        workspaceSlug: args.workspaceSlug,
        kind: args.kind,
        query: args.query,
      }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { rows?: SearchResultRow[] };
        if (!cancelled && Array.isArray(data.rows)) {
          setRows(data.rows);
        }
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [args.enabled, args.kind, args.query, args.orgSlug, args.workspaceSlug]);

  return { rows, loading };
}

// ── Main CommandMenu component ────────────────────────────────────────────────

export function CommandMenu({ ctx }: CommandMenuProps) {
  const router = useRouter();
  const pathname = usePathname();
  const pageCtx = usePageContext();
  const { recent, push: pushRecent } = useRecent();

  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [activeIndex, setActiveIndex] = React.useState(0);
  const [indexQuery, setIndexQuery] = React.useState("");
  const clampedActiveIndex = indexQuery === query ? activeIndex : 0;
  const setClampedActiveIndex = React.useCallback(
    (next: number | ((prev: number) => number)) => {
      setActiveIndex(next);
      setIndexQuery(query);
    },
    [query],
  );

  // Detect menu-close transitions.
  const prevIsOpenRef = React.useRef(pageCtx.isCommandOpen);
  React.useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = pageCtx.isCommandOpen;
    if (wasOpen && !pageCtx.isCommandOpen) {
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

  // ── Entity prefix detection ─────────────────────────────────────────────────
  const entityMatch = React.useMemo(() => matchEntityPrefix(query), [query]);
  const isSearchMode = entityMatch !== null;

  // ── LLM suggestions ─────────────────────────────────────────────
  const currentPathname =
    pathname ?? `/${ctx.orgSlug ?? ""}/${ctx.workspaceSlug ?? ""}`;
  const { suggestions, loading: suggestionsLoading } = useSuggestions({
    pathname: currentPathname,
    orgSlug: ctx.orgSlug ?? "",
    workspaceSlug: ctx.workspaceSlug ?? "",
    pageEntity: pageCtx.entity ?? null,
    recentLabels: recent.map((r) => r.query),
    isOpen: pageCtx.isCommandOpen,
  });

  // Show suggestions section only when: no query, menu is open, and results exist OR loading.
  const showSuggestions =
    !query.trim() && (suggestions.length > 0 || suggestionsLoading);

  // ── Entity search results ───────────────────────────────────────
  const { rows: searchRows, loading: searchLoading } = useEntitySearch({
    kind: entityMatch?.kind,
    query: entityMatch?.queryRemainder ?? "",
    orgSlug: ctx.orgSlug ?? "",
    workspaceSlug: ctx.workspaceSlug ?? "",
    enabled: isSearchMode,
  });

  // ── Build nav targets ───────────────────────────────────────────────────────
  const allTargets = React.useMemo(() => enumerateNavTargets(ctx), [ctx]);
  const filteredTargets = React.useMemo(() => {
    // In search mode the Navigate section is replaced by search results.
    if (isSearchMode) return [];
    if (!query.trim()) return allTargets.slice(0, 8);
    const q = query.toLowerCase();
    return allTargets
      .filter((t) => t.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [allTargets, query, isSearchMode]);

  const showRecent = !query.trim() && recent.length > 0;

  // ── Quick Actions ──────────────────────────────────────────────────────────
  const quickActions = React.useMemo(() => {
    // In search mode the Quick Actions section is replaced by search results.
    if (query.trim() || isSearchMode) return [];
    const currentPathname_ =
      pathname ?? `/${ctx.orgSlug ?? ""}/${ctx.workspaceSlug ?? ""}`;
    const pageEntity = pageCtx.entity
      ? {
          kind: pageCtx.entity.kind,
          id: pageCtx.entity.id,
          label: pageCtx.entity.label,
          summary: pageCtx.entity.summary,
        }
      : undefined;
    const routeParams = extractRouteParams(currentPathname_);
    return getApplicableTemplates({
      pathname: currentPathname_,
      routeParams,
      queryParams: {},
      pageEntity,
      capabilities: [],
      locale: "en",
    });
  }, [
    query,
    isSearchMode,
    pathname,
    ctx.orgSlug,
    ctx.workspaceSlug,
    pageCtx.entity,
  ]);

  // ── Unified items list for keyboard navigation ─────────────────────────────
  const items: CommandItem[] = React.useMemo(() => {
    const result: CommandItem[] = [];
    // Suggestions (only when no query, no search mode)
    if (!isSearchMode && !query.trim()) {
      for (const s of suggestions) {
        result.push({
          type: "suggestion",
          label: s.text,
          category: s.category,
        });
      }
    }
    // Quick Actions
    for (const t of quickActions) {
      result.push({ type: "quick-action", label: t.title, template: t });
    }
    // Search results OR Navigate
    if (isSearchMode) {
      for (const row of searchRows) {
        result.push({ type: "search-result", label: row.label, row });
      }
    } else {
      for (const t of filteredTargets) {
        result.push({ type: "navigate", label: t.label, href: t.href });
      }
    }
    // Recent
    if (showRecent) {
      for (const r of recent) {
        result.push({ type: "recent", label: r.query });
      }
    }
    // Ask fallback — always shown
    result.push({ type: "ask", label: query.trim() || "Ask Oxagen anything…" });
    return result;
  }, [
    suggestions,
    quickActions,
    searchRows,
    filteredTargets,
    showRecent,
    recent,
    query,
    isSearchMode,
  ]);

  // ── Activation ──────────────────────────────────────────────────────────────
  const activateItem = React.useCallback(
    (item: CommandItem) => {
      if (item.type === "navigate" || item.type === "search-result") {
        const href = item.type === "navigate" ? item.href : item.row.href;
        pageCtx.closeCommand();
        router.push(href);
      } else if (item.type === "suggestion") {
        // Hand off to Ask Drawer with the suggestion text as the prompt.
        pageCtx.closeCommand();
        pageCtx.openAskWithText(item.label, false);
      } else if (item.type === "quick-action") {
        const template = item.template;
        const currentPathname_ =
          pathname ?? `/${ctx.orgSlug ?? ""}/${ctx.workspaceSlug ?? ""}`;
        const routeParams = extractRouteParams(currentPathname_);
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

  // ── Render ──────────────────────────────────────────────────────────────────

  // Running index for aria-activedescendant tracking across sections.
  let sectionOffset = 0;

  return (
    <Dialog
      open={pageCtx.isCommandOpen}
      onOpenChange={(open) => !open && pageCtx.closeCommand()}
    >
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
          <Search
            className="mr-2 h-4 w-4 shrink-0 text-muted-foreground/70"
            aria-hidden="true"
          />
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
          {/* Suggested for this page — shown when no query */}
          {showSuggestions &&
            (() => {
              const baseIdx = sectionOffset;
              sectionOffset += suggestions.length;
              return (
                <CommandSection label="Suggested for this page">
                  {suggestionsLoading && suggestions.length === 0 ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground/60">
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                      <span>Loading suggestions…</span>
                    </div>
                  ) : (
                    suggestions.map((s, i) => (
                      <CommandItemRow
                        key={`sug-${i}`}
                        id={`cmd-item-${baseIdx + i}`}
                        label={s.text}
                        icon={
                          <Sparkles className="h-4 w-4" aria-hidden="true" />
                        }
                        active={clampedActiveIndex === baseIdx + i}
                        onMouseEnter={() => setClampedActiveIndex(baseIdx + i)}
                        onSelect={() =>
                          void activateItem({
                            type: "suggestion",
                            label: s.text,
                            category: s.category,
                          })
                        }
                      />
                    ))
                  )}
                </CommandSection>
              );
            })()}

          {/* Quick Actions — shown when no query and not in search mode */}
          {quickActions.length > 0 &&
            (() => {
              const baseIdx = sectionOffset;
              sectionOffset += quickActions.length;
              return (
                <CommandSection label="Quick Actions">
                  {quickActions.map((template, i) => (
                    <CommandItemRow
                      key={template.id}
                      id={`cmd-item-${baseIdx + i}`}
                      label={template.title}
                      icon={categoryIcon(template.category)}
                      active={clampedActiveIndex === baseIdx + i}
                      onMouseEnter={() => setClampedActiveIndex(baseIdx + i)}
                      onSelect={() =>
                        void activateItem({
                          type: "quick-action",
                          label: template.title,
                          template,
                        })
                      }
                      secondary={template.description}
                      trailing={
                        template.shortcut ? (
                          <kbd className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">
                            {template.shortcut}
                          </kbd>
                        ) : undefined
                      }
                    />
                  ))}
                </CommandSection>
              );
            })()}

          {/* Search results — replaces Quick Actions + Navigate in search mode */}
          {isSearchMode &&
            (() => {
              const baseIdx = sectionOffset;
              sectionOffset += searchRows.length;
              return (
                <CommandSection label="Search results">
                  {searchLoading && searchRows.length === 0 ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground/60">
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                      <span>Searching…</span>
                    </div>
                  ) : searchRows.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground/60">
                      No results found.
                    </div>
                  ) : (
                    searchRows.map((row, i) => (
                      <CommandItemRow
                        key={`sr-${row.kind}-${row.id}`}
                        id={`cmd-item-${baseIdx + i}`}
                        label={row.label}
                        icon={entityKindIcon(row.kind)}
                        active={clampedActiveIndex === baseIdx + i}
                        onMouseEnter={() => setClampedActiveIndex(baseIdx + i)}
                        onSelect={() =>
                          void activateItem({
                            type: "search-result",
                            label: row.label,
                            row,
                          })
                        }
                        secondary={
                          row.contextLine
                            ? `${row.scope} · ${row.contextLine}`
                            : row.scope
                        }
                        trailing={
                          <ArrowRight
                            className="h-3.5 w-3.5 text-muted-foreground/50"
                            aria-hidden="true"
                          />
                        }
                      />
                    ))
                  )}
                </CommandSection>
              );
            })()}

          {/* Navigate section — hidden in search mode */}
          {!isSearchMode &&
            filteredTargets.length > 0 &&
            (() => {
              const baseIdx = sectionOffset;
              sectionOffset += filteredTargets.length;
              return (
                <CommandSection label="Navigate">
                  {filteredTargets.map((target, i) => (
                    <CommandItemRow
                      key={target.href}
                      id={`cmd-item-${baseIdx + i}`}
                      label={target.label}
                      icon={
                        <Navigation className="h-4 w-4" aria-hidden="true" />
                      }
                      active={clampedActiveIndex === baseIdx + i}
                      onMouseEnter={() => setClampedActiveIndex(baseIdx + i)}
                      onSelect={() =>
                        void activateItem({
                          type: "navigate",
                          label: target.label,
                          href: target.href,
                        })
                      }
                      trailing={
                        <ArrowRight
                          className="h-3.5 w-3.5 text-muted-foreground/50"
                          aria-hidden="true"
                        />
                      }
                    />
                  ))}
                </CommandSection>
              );
            })()}

          {/* Recent section */}
          {showRecent &&
            (() => {
              const baseIdx = sectionOffset;
              sectionOffset += recent.length;
              return (
                <CommandSection label="Recent">
                  {recent.map((entry, i) => (
                    <CommandItemRow
                      key={entry.query}
                      id={`cmd-item-${baseIdx + i}`}
                      label={entry.query}
                      icon={<Clock className="h-4 w-4" aria-hidden="true" />}
                      active={clampedActiveIndex === baseIdx + i}
                      onMouseEnter={() => setClampedActiveIndex(baseIdx + i)}
                      onSelect={() =>
                        void activateItem({
                          type: "recent",
                          label: entry.query,
                        })
                      }
                    />
                  ))}
                </CommandSection>
              );
            })()}

          {/* Empty state when query has no nav matches (non-search mode) */}
          {!isSearchMode && query.trim() && filteredTargets.length === 0 && (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              No matching pages found.
            </div>
          )}

          {/* Ask fallback — always shown */}
          {(() => {
            const askIdx = sectionOffset;
            return (
              <CommandSection label="Ask">
                <CommandItemRow
                  id={`cmd-item-${askIdx}`}
                  label={
                    query.trim()
                      ? `Ask: "${query.trim()}"`
                      : "Ask Oxagen anything…"
                  }
                  icon={
                    <Sparkles
                      className="h-4 w-4 text-foreground"
                      aria-hidden="true"
                    />
                  }
                  active={clampedActiveIndex === askIdx}
                  onMouseEnter={() => setClampedActiveIndex(askIdx)}
                  onSelect={() =>
                    void activateItem({
                      type: "ask",
                      label: query.trim() || "Ask Oxagen anything…",
                    })
                  }
                />
              </CommandSection>
            );
          })()}
        </div>

        {/* Footer keyboard hints */}
        <div className="flex items-center gap-3 border-t border-border/30 px-4 py-2 text-[10px] text-muted-foreground/50">
          <span>
            <kbd className="font-mono">&#8593;&#8595;</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">&#8629;</kbd> select
          </span>
          <span>
            <kbd className="font-mono">Esc</kbd> close
          </span>
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
      <span
        className={cn(
          "shrink-0",
          active ? "text-accent-foreground" : "text-muted-foreground/60",
        )}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {secondary && (
          <span
            className={cn(
              "block truncate text-[11px]",
              active ? "text-accent-foreground/70" : "text-muted-foreground/50",
            )}
          >
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
 */
function extractRouteParams(pathname: string): Record<string, string> {
  const segments = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};
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
