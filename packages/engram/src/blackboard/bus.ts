/**
 * Blackboard Bus — the shared memory surface for multi-agent coordination.
 *
 * Agents publish discoveries, assertions, and questions to the bus.
 * Subscribed agents receive notifications matching their patterns.
 * All writes go to the shared namespace (workspace-level) so every
 * agent in the session can see them.
 */
import type { EpisodicStore } from "../store/episodic";
import type { MemoryRecord, Namespace, EpisodicBody, SemanticBody } from "../types";
import type {
  BlackboardConfig,
  BlackboardEvent,
  BlackboardEventType,
  BlackboardPriority,
  AgentRegistration,
  Subscription,
  SubscriptionPattern,
} from "./types";
import { createRecord } from "../record";
import { computeSalience } from "../salience";

export class BlackboardBus {
  private subscriptions = new Map<string, Subscription[]>();
  private agents = new Map<string, AgentRegistration>();
  private store: EpisodicStore;
  private namespace: Namespace;
  private config: BlackboardConfig;

  constructor(store: EpisodicStore, config: BlackboardConfig) {
    this.store = store;
    this.namespace = config.namespace;
    this.config = config;
  }

  /**
   * Register an agent as a participant on the blackboard.
   */
  registerAgent(registration: AgentRegistration): void {
    this.agents.set(registration.agentId, registration);
  }

  /**
   * Unregister an agent.
   */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.subscriptions.delete(agentId);
  }

  /**
   * Publish a discovery to the shared blackboard.
   * All subscribed agents matching the event are notified.
   */
  async publishDiscovery(
    agentId: string,
    body: EpisodicBody,
    salience?: number,
    priority: BlackboardPriority = "normal",
  ): Promise<string> {
    const record = createRecord({
      kind: "episodic",
      namespace: this.namespace,
      body,
      salience: salience ?? computeSalience("episodic", body),
      confidence: 1.0,
      provenance: { author: agentId, derivedFrom: [], timestamp: Date.now() },
    });

    await this.store.append(record);
    await this.notify("discovery", agentId, record.id, priority);
    return record.id;
  }

  /**
   * Assert a semantic fact to the shared blackboard.
   */
  async assertFact(
    agentId: string,
    body: SemanticBody,
    confidence: number,
    priority: BlackboardPriority = "normal",
  ): Promise<string> {
    const record = createRecord({
      kind: "semantic",
      namespace: this.namespace,
      body,
      salience: computeSalience("semantic", body),
      confidence: Math.min(1, Math.max(0, confidence)),
      provenance: { author: agentId, derivedFrom: [], timestamp: Date.now() },
    });

    await this.store.append(record);
    await this.notify("assertion", agentId, record.id, priority);
    return record.id;
  }

  /**
   * Post a question to the blackboard — other agents may answer.
   */
  async askQuestion(
    agentId: string,
    question: string,
    targetAgents?: string[],
  ): Promise<string> {
    const body: EpisodicBody = { event: "question", payload: { question } };
    const record = createRecord({
      kind: "episodic",
      namespace: this.namespace,
      body,
      salience: 0.7,
      confidence: 1.0,
      provenance: { author: agentId, derivedFrom: [], timestamp: Date.now() },
    });

    await this.store.append(record);
    await this.notify("question", agentId, record.id, "high", targetAgents);
    return record.id;
  }

  /**
   * Subscribe to blackboard events matching a pattern.
   */
  subscribe(
    agentId: string,
    pattern: SubscriptionPattern,
    callback: Subscription["callback"],
  ): string {
    const id = `sub-${agentId}-${Date.now()}`;
    const sub: Subscription = { id, agentId, pattern, callback };
    const existing = this.subscriptions.get(agentId) ?? [];
    existing.push(sub);
    this.subscriptions.set(agentId, existing);
    return id;
  }

  /**
   * Unsubscribe.
   */
  unsubscribe(agentId: string, subscriptionId: string): void {
    const subs = this.subscriptions.get(agentId) ?? [];
    this.subscriptions.set(
      agentId,
      subs.filter((s) => s.id !== subscriptionId),
    );
  }

  /**
   * Get all registered agents.
   */
  getAgents(): AgentRegistration[] {
    return [...this.agents.values()];
  }

  /**
   * Query recent shared records.
   */
  async getRecent(limit = 50): Promise<MemoryRecord[]> {
    return this.store.recent(this.namespace, limit);
  }

  private async notify(
    type: BlackboardEventType,
    agentId: string,
    recordId: string,
    priority: BlackboardPriority,
    targets?: string[],
  ): Promise<void> {
    const event: BlackboardEvent = {
      type,
      agentId,
      recordId,
      visibility: targets ? "targeted" : "broadcast",
      targets,
      priority,
      timestamp: Date.now(),
    };

    // Notify all subscribers except the originating agent
    for (const [subscriberAgent, subs] of this.subscriptions) {
      if (subscriberAgent === agentId) continue;
      if (targets && !targets.includes(subscriberAgent)) continue;

      for (const sub of subs) {
        if (matchesPattern(event, sub.pattern)) {
          try {
            await sub.callback(event);
          } catch {
            // Subscriber errors don't break the bus
          }
        }
      }
    }
  }
}

function matchesPattern(event: BlackboardEvent, pattern: SubscriptionPattern): boolean {
  if (pattern.eventTypes && !pattern.eventTypes.includes(event.type)) return false;
  // Other pattern filters would check the record itself — requires a store lookup.
  // For now, event-type filtering is the primary mechanism.
  return true;
}
