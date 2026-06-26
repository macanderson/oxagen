/**
 * Intent Ledger — prevents duplicate work across agents.
 *
 * Before starting work on a target (file, entity, task), an agent claims
 * an intent. If another agent already claimed overlapping targets, the
 * claim fails and the second agent can wait or skip.
 *
 * Intents auto-expire after a TTL to prevent deadlocks from crashed agents.
 */

export type IntentStatus = "claimed" | "in_progress" | "completed" | "abandoned";

export interface Intent {
  id: string;
  agentId: string;
  /** What the agent plans to do (e.g., "fix", "refactor", "test"). */
  action: string;
  /** File paths, entity IDs, or other identifiers being worked on. */
  targets: string[];
  status: IntentStatus;
  claimedAt: number;
  /** Auto-abandon if not completed by this time. */
  expiresAt: number;
  /** Result payload once completed. */
  result?: unknown;
}

export interface ClaimResult {
  success: boolean;
  intentId?: string;
  conflictingIntent?: Intent;
}

export class IntentLedger {
  private intents = new Map<string, Intent>();
  private idCounter = 0;

  /**
   * Claim an intent on a set of targets. Returns success if no other
   * active agent holds conflicting claims.
   */
  claim(
    agentId: string,
    action: string,
    targets: string[],
    ttlMs = 300_000,
  ): ClaimResult {
    this.expireStale();

    const conflict = this.findConflict(action, targets, agentId);
    if (conflict) {
      return { success: false, conflictingIntent: conflict };
    }

    const id = `intent-${++this.idCounter}-${agentId}`;
    const intent: Intent = {
      id,
      agentId,
      action,
      targets,
      status: "claimed",
      claimedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };

    this.intents.set(id, intent);
    return { success: true, intentId: id };
  }

  /**
   * Mark an intent as in-progress (agent started working).
   */
  start(intentId: string): void {
    const intent = this.intents.get(intentId);
    if (!intent) return;
    intent.status = "in_progress";
  }

  /**
   * Complete an intent and optionally share the result.
   */
  complete(intentId: string, result?: unknown): void {
    const intent = this.intents.get(intentId);
    if (!intent) return;
    intent.status = "completed";
    intent.result = result;
  }

  /**
   * Abandon an intent (agent gave up or errored).
   */
  abandon(intentId: string): void {
    const intent = this.intents.get(intentId);
    if (!intent) return;
    intent.status = "abandoned";
  }

  /**
   * Get all active intents for an agent.
   */
  getAgentIntents(agentId: string): Intent[] {
    this.expireStale();
    return [...this.intents.values()].filter(
      (i) => i.agentId === agentId && (i.status === "claimed" || i.status === "in_progress"),
    );
  }

  /**
   * Get all active intents across all agents.
   */
  getAllActive(): Intent[] {
    this.expireStale();
    return [...this.intents.values()].filter(
      (i) => i.status === "claimed" || i.status === "in_progress",
    );
  }

  /**
   * Check if specific targets are currently claimed.
   */
  isTargetClaimed(targets: string[], excludeAgent?: string): boolean {
    this.expireStale();
    return this.findConflict("", targets, excludeAgent) !== undefined;
  }

  private findConflict(action: string, targets: string[], excludeAgent?: string): Intent | undefined {
    for (const intent of this.intents.values()) {
      if (intent.status === "completed" || intent.status === "abandoned") continue;
      if (excludeAgent && intent.agentId === excludeAgent) continue;
      if (hasOverlap(intent.targets, targets)) {
        return intent;
      }
    }
    return undefined;
  }

  private expireStale(): void {
    const now = Date.now();
    for (const intent of this.intents.values()) {
      if (
        (intent.status === "claimed" || intent.status === "in_progress") &&
        intent.expiresAt < now
      ) {
        intent.status = "abandoned";
      }
    }
  }

  /** Clear all intents (for tests). */
  clear(): void {
    this.intents.clear();
  }
}

function hasOverlap(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  return b.some((item) => setA.has(item));
}
