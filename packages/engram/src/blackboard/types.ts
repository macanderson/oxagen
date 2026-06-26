/**
 * Blackboard protocol types — shared memory bus for multi-agent coordination.
 */
import type { Namespace, RecordKind } from "../types";

export interface BlackboardConfig {
  /** Shared namespace (workspace-level). */
  namespace: Namespace;
  /** Max records before oldest are evicted from the hot layer. */
  maxRetention: number;
}

export interface AgentRegistration {
  agentId: string;
  role: string;
  capabilities: string[];
  registeredAt: number;
}

export type BlackboardEventType =
  | "discovery"
  | "assertion"
  | "question"
  | "coordination"
  | "intent";

export type BlackboardPriority = "low" | "normal" | "high" | "urgent";

export interface BlackboardEvent {
  type: BlackboardEventType;
  agentId: string;
  recordId: string;
  visibility: "broadcast" | "targeted";
  targets?: string[];
  priority: BlackboardPriority;
  timestamp: number;
}

export interface SubscriptionPattern {
  kinds?: RecordKind[];
  domains?: string[];
  entityTypes?: string[];
  minSalience?: number;
  eventTypes?: BlackboardEventType[];
}

export interface Subscription {
  id: string;
  agentId: string;
  pattern: SubscriptionPattern;
  callback: (event: BlackboardEvent) => Promise<void>;
}
