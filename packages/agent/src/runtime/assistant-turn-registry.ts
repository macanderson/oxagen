// The running `ask_assistant` turns a person can stop (#4164), keyed by the
// organisation, the workspace, the person who asked and the turn id their
// client minted. `cancel_assistant_turn` looks a turn up by the same four
// values, so a stop reaches only the asker's own turn in the workspace they
// asked in.
//
// A stop can arrive before its turn registers: the client mints the id and
// can press Stop while the question is still being checked and admitted. That
// stop is held for a minute, and the turn stops as soon as it registers. The
// held set is capped so a caller cannot grow it without bound.
//
// The map lives on `globalThis` for the same reason the capability registry
// does (`packages/oxagen/src/registry.ts`): a bundler that loads this module
// twice must not split the turns across two maps, where a stop would look in
// the one the turn is not in.
//
// This is process memory. A stop reaches a turn only in the process running
// it. Production runs one app node. A second replica needs the stop routed to
// the replica that holds the turn.

/** The reason a person's stop aborts with; the run's seal carries it. */
export const ASSISTANT_TURN_STOP_REASON = "stopped by the person who asked";

/** How long a stop that arrived before its turn is held. */
export const HELD_STOP_TTL_MS = 60_000;

/** The most held stops kept at once; the oldest is dropped first. */
export const HELD_STOP_CAP = 1_000;

export interface AssistantTurnKey {
  orgId: string;
  workspaceId: string;
  /** The person who asked: the acting user, not the API key's principal. */
  userId: string;
  /** The id the caller minted and passed to `ask_assistant`. */
  turnId: string;
}

export interface RegisteredAssistantTurn {
  /** Aborts, with `ASSISTANT_TURN_STOP_REASON`, when the person stops it. */
  signal: AbortSignal;
  /** Drops the turn. Call once it ends, however it ends. */
  release(): void;
}

interface TurnStore {
  running: Map<string, AbortController>;
  /** Key to the time, in ms, the held stop expires. Insertion ordered. */
  held: Map<string, number>;
}

const STORE_KEY = Symbol.for("oxagen.agent.assistant-turn-registry");

function store(): TurnStore {
  const g = globalThis as { [STORE_KEY]?: TurnStore };
  g[STORE_KEY] ??= { running: new Map(), held: new Map() };
  return g[STORE_KEY];
}

function keyOf(k: AssistantTurnKey): string {
  return `${k.orgId}:${k.workspaceId}:${k.userId}:${k.turnId}`;
}

function pruneHeld(held: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of held) {
    if (expiresAt <= now) held.delete(key);
  }
}

/**
 * Register a running turn. When a stop for it is already held, the returned
 * signal is aborted before this returns.
 */
export function registerAssistantTurn(
  key: AssistantTurnKey,
): RegisteredAssistantTurn {
  const { running, held } = store();
  const k = keyOf(key);
  const controller = new AbortController();
  // A client that reuses an id replaces the earlier entry. Each release
  // removes only its own controller, so the later turn stays stoppable.
  running.set(k, controller);
  pruneHeld(held, Date.now());
  if (held.delete(k)) controller.abort(ASSISTANT_TURN_STOP_REASON);
  return {
    signal: controller.signal,
    release: () => {
      if (running.get(k) === controller) running.delete(k);
    },
  };
}

/**
 * Stop the named turn. `found` is true when a running turn took the stop.
 * When none is running, the stop is held for `HELD_STOP_TTL_MS` in case the
 * turn has not registered yet. Stopping twice is harmless.
 */
export function stopAssistantTurn(key: AssistantTurnKey): { found: boolean } {
  const { running, held } = store();
  const k = keyOf(key);
  const controller = running.get(k);
  if (controller) {
    const found = !controller.signal.aborted;
    controller.abort(ASSISTANT_TURN_STOP_REASON);
    return { found };
  }
  const now = Date.now();
  pruneHeld(held, now);
  held.delete(k);
  held.set(k, now + HELD_STOP_TTL_MS);
  while (held.size > HELD_STOP_CAP) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
  return { found: false };
}

/** Test reset: forget every running turn and held stop. */
export function clearAssistantTurnsForTests(): void {
  const s = store();
  s.running.clear();
  s.held.clear();
}
