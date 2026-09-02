import { logger } from "../../middleware/logger";
import type { A2AArtifactUpdateEvent, A2AStatusUpdateEvent } from "./protocol";

type A2AStreamEvent = A2AStatusUpdateEvent | A2AArtifactUpdateEvent;
type Listener = (event: A2AStreamEvent) => void;

/**
 * In-process pub-sub for A2A task events, keyed by the task's wire id
 * (a2a_tasks.public_id). `tasks/resubscribe` (rpc.ts) subscribes here to
 * live-attach to a non-terminal task; `runA2ATask` (bridge.ts) publishes every
 * status-update/artifact-update it emits, in addition to (unchanged) writing
 * straight to its own SSE connection when one is open.
 *
 * KNOWN LIMIT — same-instance only. Vercel Fluid Compute reuses instances
 * across concurrent requests, so this covers the common case (a client
 * resubscribing shortly after message/send on a still-warm instance). A
 * resubscribe that lands on a DIFFERENT instance than the one running the task
 * gets the initial status snapshot and then nothing, until the client polls
 * tasks/get. Making resubscribe durable across instances needs shared pub-sub
 * (Postgres LISTEN/NOTIFY or a queue) and is not built.
 */
const registry = new Map<string, Set<Listener>>();

/**
 * Publish an event to every listener currently subscribed to `taskId`. A
 * no-op — never throws — when nobody is subscribed, which is the common case
 * for message/send's own execution (it has no live resubscriber yet).
 */
export function publish(taskId: string, event: A2AStreamEvent): void {
  const listeners = registry.get(taskId);
  if (!listeners || listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // A misbehaving listener must never break delivery to the others, or
      // corrupt the publisher's (bridge.ts) own execution flow.
      logger.warn({ err, taskId }, "[a2a.stream-registry] listener threw");
    }
  }
}

/**
 * Subscribe to a task's live event stream. Returns an unsubscribe function
 * that MUST be called when the caller stops listening (client disconnect or
 * terminal event) — it removes the listener and, once the set for that task
 * id is empty, deletes the Map entry itself, so a long series of short-lived
 * A2A tasks never leaves an empty Set behind (a slow memory leak).
 */
export function subscribe(taskId: string, listener: Listener): () => void {
  let listeners = registry.get(taskId);
  if (!listeners) {
    listeners = new Set();
    registry.set(taskId, listeners);
  }
  listeners.add(listener);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const current = registry.get(taskId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) registry.delete(taskId);
  };
}

/** Test-only introspection: how many listeners are subscribed to a task id. */
export function _listenerCountForTest(taskId: string): number {
  return registry.get(taskId)?.size ?? 0;
}

/** Test-only introspection: whether the registry retains an entry for a task id. */
export function _hasEntryForTest(taskId: string): boolean {
  return registry.has(taskId);
}
