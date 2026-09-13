"use client";

// audit-filter-bar.tsx — client filter controls for the audit-log viewer.
// All state lives in the URL (?event_type=&outcome=&actor=&q=&from=&to=) so the
// view is shareable and the signed export hits the exact same rows. Any change
// resets pagination (drops the cursor → back to page 1).

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  EVENT_TYPE_GROUPS,
  SECURITY_OUTCOMES,
  eventTypesInGroup,
} from "@/lib/audit-filters";

export interface AuditFilterBarProps {
  /** Currently-selected event types (from the parsed URL filter). */
  selectedEventTypes: string[];
  selectedOutcome: string | null;
  q: string | null;
  from: string | null;
  to: string | null;
}

export function AuditFilterBar({
  selectedEventTypes,
  selectedOutcome,
  q,
  from,
  to,
}: AuditFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // Local input state, seeded from the URL's `q`. When `q` changes externally
  // (e.g. the Clear button rewrites the URL), re-sync during render via the
  // previous-value sentinel — React's recommended alternative to a setState
  // effect (https://react.dev/learn/you-might-not-need-an-effect).
  const [text, setText] = React.useState(q ?? "");
  const [lastQ, setLastQ] = React.useState(q);
  if (q !== lastQ) {
    setLastQ(q);
    setText(q ?? "");
  }

  // Build a fresh URLSearchParams from the current URL, drop the cursor, and let
  // the caller mutate it before we navigate.
  const commit = React.useCallback(
    (mutate: (sp: URLSearchParams) => void) => {
      const sp = new URLSearchParams(params.toString());
      sp.delete("cursor"); // any filter change returns to the first page
      mutate(sp);
      router.push(`${pathname}?${sp.toString()}`);
    },
    [params, pathname, router],
  );

  const selected = new Set(selectedEventTypes);
  const groupActive = (group: string): boolean => {
    const types = eventTypesInGroup(group);
    return types.length > 0 && types.every((t) => selected.has(t));
  };
  const anyGroupActive = selectedEventTypes.length > 0;

  const toggleGroup = (group: string) =>
    commit((sp) => {
      const types = eventTypesInGroup(group);
      const isActive = groupActive(group);
      // Recompute the event_type set from current selection ± this group.
      const next = new Set(selected);
      for (const t of types) {
        if (isActive) next.delete(t);
        else next.add(t);
      }
      sp.delete("event_type");
      for (const t of next) sp.append("event_type", t);
    });

  const clearAll = () =>
    commit((sp) => {
      for (const k of ["event_type", "outcome", "actor", "q", "from", "to"])
        sp.delete(k);
    });

  const setParam = (key: string, value: string | null) =>
    commit((sp) => {
      if (value && value.length > 0) sp.set(key, value);
      else sp.delete(key);
    });

  const hasFilter =
    anyGroupActive || !!selectedOutcome || !!q || !!from || !!to;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3">
      {/* Event-type group chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => commit((sp) => sp.delete("event_type"))}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
            !anyGroupActive
              ? "border-primary/40 bg-primary/15 text-foreground"
              : "border-border/60 bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          All events
        </button>
        {EVENT_TYPE_GROUPS.map((group) => (
          <button
            key={group}
            type="button"
            onClick={() => toggleGroup(group)}
            className={cn(
              "rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
              groupActive(group)
                ? "border-primary/40 bg-primary/15 text-foreground"
                : "border-border/60 bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {group}.*
          </button>
        ))}
      </div>

      {/* Free-text + outcome + date range */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
        <form
          className="relative flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setParam("q", text.trim() || null);
          }}
        >
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter by capability, IP, request ID, user agent…"
            aria-label="Free-text audit filter"
            className="w-full rounded-md border border-border/60 bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </form>

        <select
          aria-label="Outcome filter"
          value={selectedOutcome ?? ""}
          onChange={(e) => setParam("outcome", e.target.value || null)}
          className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">All outcomes</option>
          {SECURITY_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>

        <input
          type="date"
          aria-label="From date"
          value={from ? from.slice(0, 10) : ""}
          onChange={(e) =>
            setParam(
              "from",
              e.target.value
                ? new Date(e.target.value + "T00:00:00Z").toISOString()
                : null,
            )
          }
          className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <input
          type="date"
          aria-label="To date"
          value={to ? to.slice(0, 10) : ""}
          onChange={(e) =>
            setParam(
              "to",
              e.target.value
                ? new Date(e.target.value + "T23:59:59Z").toISOString()
                : null,
            )
          }
          className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />

        {hasFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="shrink-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Clear
          </Button>
        )}
      </div>

      {anyGroupActive && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Active:
          </span>
          {selectedEventTypes.map((t) => (
            <Badge key={t} variant="muted" className="text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
