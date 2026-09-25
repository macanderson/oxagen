"use client";
// Which record the page on screen is showing, declared by the page itself.
//
// The assistant flyout asks the agent about what is on screen, so it sends the
// page's route and the id of the record on it. It used to derive that id from
// the URL: the path segment after the route, or, for a route that keeps its
// selection in the query string, an allow-list of query keys. Reading the URL
// is guessing, and it was wrong three different ways. `/spend?tab=budgets&
// finding=fnd_1` renders no finding, because `parseSpendView` ignores a
// `finding` outside the Findings tab, but the URL still says one. On
// `/register/wrap?agent=agt_1` the segment after the route is the step and the
// record is in the query. And any value under the length cap was accepted, so a
// crafted or stale query parameter reached the agent as page context, which
// `assistant-turn.ts` interpolates as system-injected -- grounding an answer on
// a record nobody is looking at.
//
// Every one of those is the same defect: two readings of one URL, the page's
// and the shell's, and only the page's is authoritative. So the page declares.
// `parseSpendView` and `parseSteeringView` already decide what is on screen, in
// order to render it; the page passes that decision here rather than leaving
// the shell to re-derive it through rules that have to be kept in step.
//
// A route whose record is a path segment (`runs/[run]`, `agents/[agent]`) needs
// no declaration for its id: the URL cannot disagree with the page about it,
// because there is nothing to parse. The flyout reads those from the path. The
// Run, agent and Mandate pages declare anyway, to name the record, and they
// declare the id as the URL names it, so the id the flyout sends is unchanged.
//
// A page may also declare the record's label, for the breadcrumb and for the
// assistant. The segment is a key (`tch_…`) and a person reads the name the
// page drew from the record (`mbell-mbp-16`); only the page has read the
// record, so only it can say. The flyout sends the label beside the id
// (`page-label.ts`), so the agent can cite the record by that name.
//
// The store is a module singleton rather than context because the page is not
// inside the shell's provider: `ShellClient` renders chrome, and the layout
// places the page beside it. It holds one entry because one page is on screen.
//
// The entry carries the route it was declared for and the flyout only reads it
// when that route matches the one it is looking at. An entry left by the page
// being navigated away from is therefore unusable rather than stale, which
// matters because React is free to mount the next page before unmounting the
// last.
import { useEffect, useSyncExternalStore } from "react";

type Entry = { route: string; id: string | null; label: string | null };

let current: Entry | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * What `route` has declared it is showing, or null when it has declared
 * nothing. Reading through the route is what makes a leftover entry unusable
 * instead of wrong.
 *
 * The declaration is returned wrapped rather than as a bare id, because a page
 * declaring `{ id: null }` is saying "no particular record" and that has to
 * outrank the path segment. A bare null could not tell the two apart.
 */
export function usePageRecord(
  route: string | null,
): { id: string | null; label: string | null } | null {
  const entry = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  if (entry === null || route === null || entry.route !== route) return null;
  return { id: entry.id, label: entry.label };
}

/**
 * Declare the record this page is showing, for the assistant to be asked about.
 *
 * Render it from the page with the id the page's own view parser produced, so
 * the two cannot disagree. A page showing no particular record renders nothing
 * here, or passes `null` when the selection is optional.
 */
export function PageRecord({
  route,
  id,
  label = null,
}: {
  /** The first path segment after the workspace, as `parseShellPath` reads it. */
  route: string;
  /** The record on screen, from the page's own parse of its query. */
  id: string | null;
  /** The record's name as the page drew it: the breadcrumb's text, and the label the assistant is sent. */
  label?: string | null;
}) {
  useEffect(() => {
    const mine: Entry = { route, id, label };
    current = mine;
    emit();
    return () => {
      // Only if this is still the declaration on the store. The next page may
      // have mounted and declared before this one unmounted, and clearing then
      // would take its record with it.
      if (current !== mine) return;
      current = null;
      emit();
    };
  }, [route, id, label]);
  return null;
}
