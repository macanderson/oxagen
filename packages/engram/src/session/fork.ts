/**
 * Session forking — create a new branch from any point in a session's history.
 *
 * Fork creates a new session that shares the event prefix with its parent.
 * The forked session can diverge independently while the parent continues.
 */
import type { Session } from "./types";
import { createSession } from "./event-log";

/**
 * Fork a session at a given event index.
 *
 * Creates a new session that:
 * - Has parentId pointing to the source session
 * - Records the fork point (event index)
 * - Copies events 0..forkPoint into the new session's prefix
 * - Marks the new session as active for continued execution
 *
 * The parent session continues independently.
 */
export function forkSession(
  parent: Session,
  forkPoint: number,
  newSessionId: string,
): Session {
  if (forkPoint < 0 || forkPoint >= parent.events.length) {
    throw new Error(
      `Fork point ${forkPoint} out of range [0, ${parent.events.length - 1}]`,
    );
  }

  // Create a new session referencing the parent
  const forked = createSession(
    newSessionId,
    parent.namespace,
    parent.id,
    forkPoint,
  );

  // Copy the prefix events (everything up to and including forkPoint)
  // We don't duplicate them in the event array — the fork reference
  // is enough to reconstruct the full history via getFullHistory().
  // The forked session starts with just its session_start event.

  return forked;
}

/**
 * Get the full event history for a session, including inherited prefix
 * from parent (if forked). Resolves the whole ancestor chain, so a fork
 * of a fork still carries its grandparent's prefix.
 */
export function getFullHistory(
  session: Session,
  resolveParent: (id: string) => Session | null,
): { events: Session["events"]; inherited: number } {
  return getFullHistoryInner(session, resolveParent, new Set());
}

function getFullHistoryInner(
  session: Session,
  resolveParent: (id: string) => Session | null,
  visited: Set<string>,
): { events: Session["events"]; inherited: number } {
  if (!session.parentId || session.forkPoint === undefined) {
    return { events: session.events, inherited: 0 };
  }
  // Corrupt-data guard: a parentId cycle would otherwise recurse forever.
  if (visited.has(session.id)) {
    return { events: session.events, inherited: 0 };
  }
  visited.add(session.id);

  const parent = resolveParent(session.parentId);
  if (!parent) {
    // Parent not found — return own events only
    return { events: session.events, inherited: 0 };
  }

  // Reconstruct the PARENT's full history first, so a multi-generation fork
  // chain keeps the grandparent prefix instead of just a one-level slice.
  const parentFull = getFullHistoryInner(parent, resolveParent, visited);
  const parentIsFork =
    parent.parentId !== undefined && parent.forkPoint !== undefined;
  // forkPoint indexes the parent's OWN event array. Map it onto the parent's
  // reconstructed history: a forked parent's events[0] (session_start) is not
  // part of its history — its own events start at full index `inherited`,
  // shifted down by one. A root parent's events map 1:1.
  const cut = parentIsFork
    ? parentFull.inherited + session.forkPoint
    : session.forkPoint + 1;
  const parentHistory = parentFull.events.slice(0, cut);
  // Skip the session_start event from the forked session (it's a duplicate of concept)
  const ownEvents = session.events.slice(1);

  return {
    events: [...parentHistory, ...ownEvents],
    inherited: parentHistory.length,
  };
}
