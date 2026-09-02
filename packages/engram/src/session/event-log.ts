/**
 * Session event log — append-only event store for agent sessions.
 *
 * The event log is the source of truth for session state. All state
 * is derived by replaying events. This enables fork/replay/time-travel.
 */
import type { Namespace } from "../types";
import type { Session, SessionEvent, SessionEventType } from "./types";

/**
 * Create a new session.
 */
export function createSession(
  id: string,
  namespace: Namespace,
  parentId?: string,
  forkPoint?: number,
): Session {
  const session: Session = {
    id,
    namespace,
    parentId,
    forkPoint,
    events: [],
    createdAt: Date.now(),
    status: "active",
  };

  // Record the session start event
  appendEvent(session, "session_start", null, {
    sessionId: id,
    parentId: parentId ?? null,
    forkPoint: forkPoint ?? null,
  });

  return session;
}

/**
 * Append an event to the session log.
 * Events are immutable once appended — this is append-only.
 */
export function appendEvent(
  session: Session,
  type: SessionEventType,
  turnId: string | null,
  data: unknown,
): SessionEvent {
  if (session.status !== "active") {
    throw new Error(
      `Cannot append to session ${session.id}: status is ${session.status}`,
    );
  }

  const event: SessionEvent = {
    index: session.events.length,
    type,
    turnId,
    data,
    timestamp: Date.now(),
  };

  session.events.push(event);

  // Auto-transition status on session_end
  if (type === "session_end") {
    session.status = "completed";
  }

  return event;
}

/**
 * Get all events for a specific turn.
 */
export function getEventsForTurn(
  session: Session,
  turnId: string,
): SessionEvent[] {
  return session.events.filter((e) => e.turnId === turnId);
}

/**
 * Get events up to a specific index (for replay/time-travel).
 */
export function getEventsUpTo(session: Session, index: number): SessionEvent[] {
  return session.events.slice(0, index + 1);
}

/**
 * Get the number of turns in a session.
 */
export function getTurnCount(session: Session): number {
  return session.events.filter((e) => e.type === "turn_start").length;
}

/**
 * Get all turn IDs in order.
 */
export function getTurnIds(session: Session): string[] {
  return session.events
    .filter((e) => e.type === "turn_start")
    .map((e) => e.turnId!)
    .filter(Boolean);
}

/**
 * End a session. After this, no more events can be appended.
 */
export function endSession(session: Session, reason: string): void {
  appendEvent(session, "session_end", null, { reason });
}
