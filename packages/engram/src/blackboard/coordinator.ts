/**
 * Agent Coordinator — high-level API for multi-agent collaboration.
 *
 * Combines the blackboard bus, intent ledger, and lease manager into
 * a simple interface that agents use before/after work.
 */
import type { BlackboardBus } from "./bus";
import type { IntentLedger } from "./intent";
import type { LeaseManager } from "./lease";

export type WorkDecision = "proceed" | "wait" | "skip";

export interface CoordinationResult {
  decision: WorkDecision;
  intentId?: string;
  conflictAgent?: string;
  reason: string;
}

export class AgentCoordinator {
  constructor(
    private bus: BlackboardBus,
    private intents: IntentLedger,
    private leases: LeaseManager,
  ) {}

  /**
   * Before starting work, check if another agent is already handling it.
   *
   * Returns:
   * - "proceed" + intentId: work is claimed, go ahead
   * - "wait": another agent is actively working on this, wait for their result
   * - "skip": another agent already completed this work
   */
  beforeWork(
    agentId: string,
    action: string,
    targets: string[],
    ttlMs?: number,
  ): CoordinationResult {
    const claim = this.intents.claim(agentId, action, targets, ttlMs);

    if (claim.success) {
      this.intents.start(claim.intentId!);
      return {
        decision: "proceed",
        intentId: claim.intentId,
        reason: "Work claimed successfully",
      };
    }

    const conflict = claim.conflictingIntent!;
    if (conflict.status === "completed") {
      return {
        decision: "skip",
        conflictAgent: conflict.agentId,
        reason: `Already completed by ${conflict.agentId}`,
      };
    }

    return {
      decision: "wait",
      conflictAgent: conflict.agentId,
      reason: `In progress by ${conflict.agentId} (expires ${new Date(conflict.expiresAt).toISOString()})`,
    };
  }

  /**
   * After completing work, mark the intent as done and broadcast the result.
   */
  async afterWork(
    agentId: string,
    intentId: string,
    result: unknown,
  ): Promise<void> {
    this.intents.complete(intentId, result);

    // Broadcast the completion to the blackboard
    await this.bus.publishDiscovery(
      agentId,
      {
        event: "work_completed",
        payload: { intentId, result },
        outcome: "success",
      },
      0.7,
      "high",
    );
  }

  /**
   * Acquire an exclusive lease on a resource before operating on it.
   */
  acquireLease(
    agentId: string,
    resource: string,
    ttlMs?: number,
  ): { acquired: boolean; reason: string } {
    const result = this.leases.acquire(agentId, resource, ttlMs);
    if (result.granted) {
      return { acquired: true, reason: "Lease acquired" };
    }
    return {
      acquired: false,
      reason: `Resource held by ${result.heldBy} until ${new Date(result.expiresAt!).toISOString()}`,
    };
  }

  /**
   * Release a lease after work is complete.
   */
  releaseLease(agentId: string, resource: string): void {
    this.leases.release(resource, agentId);
  }

  /**
   * Abandon work (agent errored or was interrupted).
   */
  abandonWork(intentId: string): void {
    this.intents.abandon(intentId);
  }
}
