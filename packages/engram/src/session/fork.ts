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
 * from parent (if forked).
 */
export function getFullHistory(
  session: Session,
  resolveParent: (id: string) => Session | null,
): { events: Session["events"]; inherited: number } {
  if (!session.parentId || session.forkPoint === undefined) {
    return { events: session.events, inherited: 0 };
  }

  const parent = resolveParent(session.parentId);
  if (!parent) {
    // Parent not found — return own events only
    return { events: session.events, inherited: 0 };
  }

  // Get parent's history up to the fork point
  const parentHistory = parent.events.slice(0, session.forkPoint + 1);
  // Skip the session_start event from the forked session (it's a duplicate of concept)
  const ownEvents = session.events.slice(1);

  return {
    events: [...parentHistory, ...ownEvents],
    inherited: parentHistory.length,
  };
}
