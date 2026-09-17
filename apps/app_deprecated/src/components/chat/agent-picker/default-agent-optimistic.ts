/**
 * default-agent-optimistic.ts — the pure decision behind the agent picker's
 * optimistic "default assistant" star.
 *
 * The chat shell applies the picked id to local state immediately (optimistic),
 * fires `setDefaultAgentAction`, then settles on whatever this helper returns:
 *   - success → keep the id the user just picked;
 *   - failure → revert to `serverDefaultId`, the value the server last confirmed,
 *     NOT the pre-toggle local value. Reverting to the server value is deliberate:
 *     the local value could itself be a stale, unconfirmed optimistic guess from a
 *     rapid double-toggle, so the server-confirmed default is the only safe anchor.
 */

/** Minimal shape of the server action's result the decision depends on. */
export interface DefaultAgentActionResult {
  ok: boolean;
}

/**
 * Given the resolved action result, the id the user optimistically applied, and
 * the server-confirmed default, return the id the UI should settle on.
 */
export function resolveOptimisticDefaultAgent(
  result: DefaultAgentActionResult,
  attemptedId: string | null,
  serverDefaultId: string | null,
): string | null {
  return result.ok ? attemptedId : serverDefaultId;
}
