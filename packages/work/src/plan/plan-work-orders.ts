// plan-work-orders.ts: place ready tasks into work orders with an order between them.
//
// planWorkOrders is pure: the same input always gives the same plan, so a test
// can pin one. work-in-flight-spec.md §8.3 sets the rules, applied in order:
//
// 1. Provider order first. A blocker comes before what it blocks, whatever
//    their priorities.
// 2. Group small conflicts. Tasks joined by a conflict share one work order when
//    their estimates sum to GROUP_MAX_MINUTES or less.
// 3. Sequence large conflicts. Otherwise conflicting work orders run in
//    sequence: higher priority first, then the smaller estimate, then the lower
//    task number.
// 4. Parallelize the rest, up to each target's capacity and within the money.
//
// Two claims conflict when they name one repository, at least one is
// exclusive, and one glob's literal prefix starts with the other's (§7.4). A
// claim that touches a serial group is exclusive over the whole group (§7.3).
// Every placement and every edge carries one reason.
import { notBuilt } from "../not-built";
import type { PriorityLabel } from "../types";

/** Tasks joined by a conflict share a work order when their estimates sum to this many agent minutes or less. */
export const GROUP_MAX_MINUTES = 120;

/** An agent's capacity when its registration sets none. */
export const MAX_OPEN_WORK_ORDERS_DEFAULT = 1;

/** Whether a claim may overlap another. Two shared claims never conflict. */
export const CLAIM_MODES = ["exclusive", "shared"] as const;
export type ClaimMode = (typeof CLAIM_MODES)[number];

/** Where a claim came from (§7.2). */
export const CLAIM_SOURCES = ["predicted", "declared", "observed"] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

/** What a work order may change: one repository, one path glob, and a mode. */
export interface Claim {
  /** owner/name */
  repo: string;
  glob: string;
  mode: ClaimMode;
  source: ClaimSource;
}

/** A set of paths that conflict whatever the tasks say, from a repository's .oxagen/serial.toml. */
export interface SerialGroup {
  /** owner/name */
  repo: string;
  name: string;
  paths: string[];
}

/** One ready task. */
export interface PlanTask {
  /** The work item's id. */
  item: string;
  /** The number people see, which breaks the last tie in rule 3. */
  number: number;
  priority: PriorityLabel | null;
  /** Estimated agent minutes, or null before one is drafted. */
  estimateMinutes: number | null;
  projectedUsd?: number;
  claims: Claim[];
}

/** A provider relation read at import: `blocker` comes before `blocked`. */
export interface ProviderOrder {
  blocker: string;
  blocked: string;
}

/** A work order already in flight, whose live claims the plan must not collide with. */
export interface InFlightWorkOrder {
  workOrder: string;
  claims: Claim[];
  /** True when no frame arrived for CLAIM_STALE_MINUTES. A stale claim still blocks. */
  stale: boolean;
}

/** An agent or a pool the person picked, with what it can still take. */
export interface PlanTarget {
  /** An agent lineage or a pool name. */
  target: string;
  maxOpenWorkOrders: number;
  openWorkOrders: number;
  /** What remains of the agent's mandate budget. Omitted when the mandate sets none. */
  remainingBudgetUsd?: number;
}

/** A pair of claims a person marked `no conflict` for this plan. */
export interface NoConflictPair {
  a: Pick<Claim, "repo" | "glob">;
  b: Pick<Claim, "repo" | "glob">;
}

/** The input to planWorkOrders. */
export interface PlanInput {
  tasks: readonly PlanTask[];
  providerOrder: readonly ProviderOrder[];
  inFlight: readonly InFlightWorkOrder[];
  targets: readonly PlanTarget[];
  /** The plan's spend cap. Omitted when the person set none. */
  spendCapUsd?: number;
  noConflict: readonly NoConflictPair[];
  serialGroups: readonly SerialGroup[];
}

/** One proposed work order. */
export interface PlannedWorkOrder {
  /** A key that is stable for the same input, such as `wo-1`. */
  key: string;
  /** The work items it carries, in order. */
  items: string[];
  target: string;
  claims: Claim[];
  estimateMinutes: number;
  projectedUsd: number;
  /** Why it sits where it does, such as "Grouped with #481. Both change apps/app/src/features/runs/**." */
  reason: string;
}

/** `after` waits for `before`: a planned work order key, or the id of a work order in flight. */
export interface PlanEdge {
  before: string;
  after: string;
  /** Such as "Waits for WO-12. Both change packages/database/atlas/migrations/**." */
  reason: string;
}

/** The output of planWorkOrders. Work orders with no path between them run in parallel. */
export interface Plan {
  workOrders: PlannedWorkOrder[];
  edges: PlanEdge[];
}

/** Place ready tasks into work orders. Pure. */
export function planWorkOrders(input: PlanInput): Plan {
  return notBuilt("planWorkOrders", input);
}
