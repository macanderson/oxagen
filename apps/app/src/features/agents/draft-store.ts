"use client";
// The one draft of an agent's definition file, shared by the Definition tab's
// form and the source editor (spec pages/agent-source.md, "Draft state is
// shared with the agent form, so a change made on either survives navigation
// until discarded or committed").
//
// It lives in this browser's sessionStorage, keyed by the agent and stamped
// with the base it was drafted against. That is a per-viewer convenience and
// never the record: a commit is the only write, and a draft made against a
// base that has since changed (a commit landed) is dropped rather than laid
// over the new file. Storage can be absent or refuse (a private window,
// blocked site data), so every read and write is guarded, and the page works
// without it: the draft then lives as long as the page does.
import { useCallback, useMemo, useSyncExternalStore } from "react";

type Stored = { base: string; draft: string };

const PREFIX = "oxagen.agent-draft.";
const listeners = new Set<() => void>();
/** The drafts of this tab when storage refuses, so a page still keeps its own edits. */
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    const value = window.sessionStorage.getItem(PREFIX + key);
    if (value !== null) return value;
  } catch {
    // Storage refused: fall back to this tab's memory.
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string | null) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.sessionStorage.removeItem(PREFIX + key);
    else window.sessionStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage refused: the memory copy above is the draft.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function parse(raw: string | null): Stored | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "base" in value &&
      "draft" in value &&
      typeof value.base === "string" &&
      typeof value.draft === "string"
    ) {
      return { base: value.base, draft: value.draft };
    }
  } catch {
    // A value this module did not write reads as no draft.
  }
  return null;
}

/**
 * The draft of `agent`'s file against `base`, and a setter. Setting the draft
 * back to the base clears it. The server renders the base, and the stored
 * draft takes over once the page is interactive.
 */
export function useDefinitionDraft(
  agent: string,
  base: string,
): [string, (next: string | ((current: string) => string)) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(agent),
    () => null,
  );
  const stored = useMemo(() => parse(raw), [raw]);
  const draft = stored !== null && stored.base === base ? stored.draft : base;
  const setDraft = useCallback(
    (next: string | ((current: string) => string)) => {
      const current = parse(read(agent));
      const from =
        current !== null && current.base === base ? current.draft : base;
      const value = typeof next === "function" ? next(from) : next;
      write(
        agent,
        value === base ? null : JSON.stringify({ base, draft: value }),
      );
    },
    [agent, base],
  );
  return [draft, setDraft];
}
