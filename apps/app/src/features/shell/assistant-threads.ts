"use client";
// The assistant flyout's threads, one per workspace, kept across a reload and
// a workspace rename (#4163, #3313).
//
// Every turn `ask_assistant` answers is already on the record: the question
// and the reply are rows of a conversation in Postgres. The flyout used to
// keep its thread only in component state, keyed by the `org/ws` slugs in the
// URL, so a reload showed an empty panel over a conversation that was still
// there, and renaming the workspace stranded the thread (and any reply still
// in flight) under a slug the shell would never compute again.
//
// Two things change that. The thread is read back from the record when the
// flyout opens in a workspace it has not read yet: `loadAssistantThread`
// answers the viewer's latest active conversation there. And the thread is
// filed under the workspace's id, which that same read answers, not under its
// slugs. A rename changes the slugs and never the id, so the thread, its
// draft and a turn still in flight are all waiting under the new URL.
//
// Until the read answers, the slugs stand in as the key (`org/ws`), so the
// person can type, and even ask, before it lands. When it lands the stand-in
// is adopted: its thread moves under the workspace id, and any write still
// addressed to the stand-in (a turn asked before the read answered) follows it
// there. If the workspace already has a thread in memory (the rename case) the
// two are joined; otherwise the recorded thread is restored, keeping anything
// typed meanwhile. A stand-in the person has already used is kept as it is,
// because it now holds a conversation of its own.
//
// "New thread" empties the thread on screen and forgets its conversation id,
// so the next question opens a new conversation. The old one stays on the
// record, and the next reload restores whichever of the two was asked in
// last. A read that fails leaves the stand-in in place and says so. The next
// time the flyout opens, it reads again.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantThread } from "@/data/contracts/conversations";
import type { ParkedCard, ToolCallSummary } from "./assistant-actions";
import { loadAssistantThread } from "./assistant-thread-actions";

/** One workspace's thread, whatever the flyout draws its entries as. */
export type ThreadState<E> = {
  entries: readonly E[];
  /** The conversation the next question continues; null opens a new one. */
  conversationId: string | null;
  draft: string;
  draftTooLong?: boolean;
  pending: boolean;
};

/** A turn read back from the record, in the shape a live turn produces. */
export type RestoredEntry =
  | { kind: "asked"; id: string; text: string }
  | {
      kind: "answered";
      id: string;
      text: string;
      runId: string;
      parked: readonly ParkedCard[];
      toolCalls: readonly ToolCallSummary[];
    };

/** Whether the read for the workspace on screen is out, or failed. */
export type ThreadStatus = "idle" | "loading" | "failed";

/** The prefix of a message's public id: every restored entry carries one. */
const RESTORED_ID = /^msg_/;

/**
 * Whether an entry was read back from the record rather than answered in this
 * page. A restored answer is shown whole: it was read before, and typing it
 * out again on every reload would replay a conversation as if it were new.
 */
export function isRestoredEntry(id: string): boolean {
  return RESTORED_ID.test(id);
}

/**
 * The recorded thread as entries. A question is `asked`; a reply is
 * `answered` with the run it was recorded as and the tool calls that run
 * made, so a restored reply lists what it listed when it was new (#4161). A
 * reply with no run was not an assistant turn (another chat surface wrote
 * it), and the flyout has nothing to link it to, so it is left out.
 */
function restoredEntries(thread: AssistantThread): readonly RestoredEntry[] {
  const entries: RestoredEntry[] = [];
  for (const message of thread.messages) {
    if (message.role === "user") {
      entries.push({ kind: "asked", id: message.id, text: message.text });
    } else if (message.runId !== null) {
      entries.push({
        kind: "answered",
        id: message.id,
        text: message.text,
        runId: message.runId,
        parked: message.parked,
        toolCalls: message.toolCalls,
      });
    }
  }
  return entries;
}

type Store<E> = {
  /** Threads by key: the workspace's id once read, else its `org/ws`. */
  threads: ReadonlyMap<string, ThreadState<E>>;
  /** `org/ws` to the workspace id a read answered for it. */
  keys: ReadonlyMap<string, string>;
  /** Stand-in keys the person started a new thread on before the read. */
  fresh: ReadonlySet<string>;
  /** `org/ws` pairs whose read failed since the flyout last opened. */
  failed: ReadonlySet<string>;
};

function emptyThread<E>(): ThreadState<E> {
  return { entries: [], conversationId: null, draft: "", pending: false };
}

/** A stand-in the person has asked in: it holds a conversation of its own. */
function used<E>(thread: ThreadState<E>): boolean {
  return (
    thread.entries.length > 0 ||
    thread.pending ||
    thread.conversationId !== null
  );
}

/**
 * The workspace's thread in memory and its stand-in, as one: what each holds,
 * in the order it was asked, with the draft typed last.
 */
function join<E>(
  kept: ThreadState<E>,
  standIn: ThreadState<E>,
): ThreadState<E> {
  return {
    entries: [...kept.entries, ...standIn.entries],
    conversationId: kept.conversationId ?? standIn.conversationId,
    draft: standIn.draft === "" ? kept.draft : standIn.draft,
    draftTooLong: standIn.draft === "" ? kept.draftTooLong : false,
    pending: kept.pending || standIn.pending,
  };
}

export function useAssistantThreads<E>({
  org,
  ws,
  open,
  restore,
}: {
  org: string | null;
  ws: string | null;
  /** Whether the flyout is open: the thread is read when it opens. */
  open: boolean;
  /** One restored entry as the flyout's own entry type. */
  restore: (entry: RestoredEntry) => E;
}) {
  const [store, setStore] = useState<Store<E>>(() => ({
    threads: new Map(),
    keys: new Map(),
    fresh: new Set(),
    failed: new Set(),
  }));
  // The pairs with a read out. A ref, not state: it gates starting a read,
  // and two effects in one commit must not both see it empty.
  const reading = useRef(new Set<string>());
  const restoreRef = useRef(restore);
  useEffect(() => {
    restoreRef.current = restore;
  }, [restore]);

  const pair = org === null || ws === null ? null : `${org}/${ws}`;
  const resolve = useCallback(
    (key: string) => store.keys.get(key) ?? key,
    [store.keys],
  );
  const scope = pair === null ? null : resolve(pair);

  const threadOf = useCallback(
    (key: string): ThreadState<E> | undefined =>
      store.threads.get(resolve(key)),
    [store.threads, resolve],
  );

  /** Change a thread from what it holds now, following an adopted stand-in. */
  const updateThread = useCallback(
    (key: string, change: (prior: ThreadState<E>) => ThreadState<E>) => {
      setStore((prior) => {
        const target = prior.keys.get(key) ?? key;
        const current = prior.threads.get(target) ?? emptyThread<E>();
        const threads = new Map(prior.threads).set(target, change(current));
        return { ...prior, threads };
      });
    },
    [],
  );

  // A failed read is tried again the next time the flyout opens. Adjusted
  // during render, when the flyout closes, rather than in an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setStore((prior) =>
        prior.failed.size === 0 ? prior : { ...prior, failed: new Set() },
      );
    }
  }

  useEffect(() => {
    if (
      !open ||
      org === null ||
      ws === null ||
      pair === null ||
      store.keys.has(pair) ||
      store.failed.has(pair) ||
      reading.current.has(pair)
    )
      return;
    reading.current.add(pair);
    const settle = (next: (prior: Store<E>) => Store<E>): void => {
      reading.current.delete(pair);
      setStore(next);
    };
    loadAssistantThread(org, ws).then(
      (result) => {
        if (!result.ok) {
          settle((prior) => ({
            ...prior,
            failed: new Set(prior.failed).add(pair),
          }));
          return;
        }
        const { workspaceKey, thread } = result.value;
        settle((prior) => {
          const threads = new Map(prior.threads);
          const standIn = threads.get(pair);
          const kept = threads.get(workspaceKey);
          let adopted: ThreadState<E>;
          if (kept !== undefined) {
            adopted = standIn === undefined ? kept : join(kept, standIn);
          } else if (
            standIn !== undefined &&
            (used(standIn) || prior.fresh.has(pair))
          ) {
            adopted = standIn;
          } else {
            adopted = {
              ...emptyThread<E>(),
              entries:
                thread === null
                  ? []
                  : restoredEntries(thread).map(restoreRef.current),
              conversationId: thread?.id ?? null,
              draft: standIn?.draft ?? "",
              draftTooLong: standIn?.draftTooLong ?? false,
            };
          }
          threads.delete(pair);
          threads.set(workspaceKey, adopted);
          return {
            ...prior,
            threads,
            keys: new Map(prior.keys).set(pair, workspaceKey),
          };
        });
      },
      () => {
        settle((prior) => ({
          ...prior,
          failed: new Set(prior.failed).add(pair),
        }));
      },
    );
  }, [open, org, ws, pair, store.keys, store.failed]);

  const loading =
    pair !== null && !store.keys.has(pair) && !store.failed.has(pair) && open;
  const status: ThreadStatus = loading
    ? "loading"
    : pair !== null && store.failed.has(pair)
      ? "failed"
      : "idle";

  /**
   * Empty the thread on screen and forget its conversation, so the next
   * question opens a new one. What the person has typed stays.
   */
  const startNewThread = useCallback(() => {
    if (scope === null) return;
    setStore((prior) => {
      const target = prior.keys.get(scope) ?? scope;
      const current = prior.threads.get(target) ?? emptyThread<E>();
      if (current.pending) return prior;
      const threads = new Map(prior.threads).set(target, {
        ...emptyThread<E>(),
        draft: current.draft,
        draftTooLong: current.draftTooLong ?? false,
      });
      const fresh =
        pair !== null && !prior.keys.has(pair)
          ? new Set(prior.fresh).add(pair)
          : prior.fresh;
      return { ...prior, threads, fresh };
    });
  }, [scope, pair]);

  return { scope, status, threadOf, updateThread, startNewThread };
}
