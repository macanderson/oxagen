"use client";
// The Studio draft's store: the tab's sessionStorage, one key per server. A
// draft is a convenience that lives until Review carries it into a steering
// PR or the person discards it, so a browser that refuses storage (a private
// window, blocked site data) keeps the draft in memory for the page's life
// and every read and write is guarded.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type DraftOp, parseDraft, stage, unstage } from "./draft";

const EVENT = "oxagen:studio-draft";

function keyOf(serverId: string): string {
  return `oxagen.mcp-studio.draft.${serverId}`;
}

/** Drafts held in memory when sessionStorage throws. */
const fallback = new Map<string, string>();

function read(serverId: string): string | null {
  try {
    return window.sessionStorage.getItem(keyOf(serverId));
  } catch {
    return fallback.get(serverId) ?? null;
  }
}

function write(serverId: string, ops: readonly DraftOp[]): void {
  const text = ops.length === 0 ? null : JSON.stringify(ops);
  try {
    if (text === null) window.sessionStorage.removeItem(keyOf(serverId));
    else window.sessionStorage.setItem(keyOf(serverId), text);
  } catch {
    if (text === null) fallback.delete(serverId);
    else fallback.set(serverId, text);
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: serverId }));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export type StudioDraft = {
  ops: readonly DraftOp[];
  stage: (op: DraftOp) => void;
  unstage: (index: number) => void;
  discard: () => void;
};

/** One server's draft, shared by every Studio component on the page. */
export function useStudioDraft(serverId: string): StudioDraft {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(serverId),
    () => null,
  );
  const ops = useMemo(() => parseDraft(raw), [raw]);
  const add = useCallback(
    (op: DraftOp) => {
      write(serverId, stage(parseDraft(read(serverId)), op));
    },
    [serverId],
  );
  const drop = useCallback(
    (index: number) => {
      write(serverId, unstage(parseDraft(read(serverId)), index));
    },
    [serverId],
  );
  const discard = useCallback(() => {
    write(serverId, []);
  }, [serverId]);
  return { ops, stage: add, unstage: drop, discard };
}
