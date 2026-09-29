"use client";
// The Studio draft's store: the tab's sessionStorage, one key per server. A
// draft is a convenience that lives until the person discards it, so a
// browser that refuses storage (a private window, blocked site data) keeps
// the draft in memory for the page's life and every read and write is
// guarded.
//
// A draft is keyed by the organization and workspace, then by the server's
// folder name, as lane M11 stores it (`save_studio_draft`'s `server`). The
// workspace comes first because sessionStorage is shared by the whole origin:
// two workspaces can each hold a server whose folder is `stripe`, and neither
// may read the other's draft. A server whose record has not named its folder
// yet is keyed by its registry id until then; such a draft cannot be saved,
// since Review needs the folder name.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  type DraftOp,
  parseStoredDraft,
  type StoredDraft,
  stageChecked,
  unstage,
} from "./draft";
import type { StudioAt } from "./route";

const EVENT = "oxagen:studio-draft";

/** Which server a draft belongs to, and the workspace that holds it. */
type DraftKey = { at: StudioAt; serverName: string | null; serverId: string };

/**
 * The draft's sessionStorage key. Slugs are URL path segments, so neither
 * holds a "/" and the org and workspace pair cannot be read two ways.
 */
function keyOf({ at, serverName, serverId }: DraftKey): string {
  const workspace = `oxagen.mcp-studio.draft.${at.org}/${at.ws}`;
  return serverName === null
    ? `${workspace}.id.${serverId}`
    : `${workspace}.server.${serverName}`;
}

/** Drafts held in memory when sessionStorage throws. */
const fallback = new Map<string, string>();

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return fallback.get(key) ?? null;
  }
}

function write(key: string, draft: StoredDraft): void {
  const text =
    draft.ops.length === 0 && draft.revision === 0
      ? null
      : JSON.stringify(draft);
  try {
    if (text === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, text);
  } catch {
    if (text === null) fallback.delete(key);
    else fallback.set(key, text);
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

type StudioDraft = {
  ops: readonly DraftOp[];
  /** The stored revision the draft was last saved over; 0 before any save. */
  revision: number;
  /** False when the edit would break the draft's shape, so nothing was staged. */
  stage: (op: DraftOp) => boolean;
  unstage: (index: number) => void;
  /** Drop every edit. The revision stays, so the next save is not refused. */
  discard: () => void;
  /** Take a stored draft's edits and revision, after a save or a merge. */
  replace: (draft: StoredDraft) => void;
};

/** One server's draft, shared by every Studio component on the page. */
export function useStudioDraft(server: DraftKey): StudioDraft {
  const key = keyOf(server);
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const draft = useMemo(() => parseStoredDraft(raw), [raw]);
  const add = useCallback(
    (op: DraftOp): boolean => {
      const current = parseStoredDraft(read(key));
      const next = stageChecked(current.ops, op);
      if (next === null) return false;
      write(key, { revision: current.revision, ops: next });
      return true;
    },
    [key],
  );
  const drop = useCallback(
    (index: number) => {
      const current = parseStoredDraft(read(key));
      write(key, {
        revision: current.revision,
        ops: unstage(current.ops, index),
      });
    },
    [key],
  );
  const discard = useCallback(() => {
    write(key, { revision: parseStoredDraft(read(key)).revision, ops: [] });
  }, [key]);
  const replace = useCallback(
    (next: StoredDraft) => {
      write(key, next);
    },
    [key],
  );
  return {
    ops: draft.ops,
    revision: draft.revision,
    stage: add,
    unstage: drop,
    discard,
    replace,
  };
}
