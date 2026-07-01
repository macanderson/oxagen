/**
 * Router contract surface (pipeline Group 2 — already shipped).
 *
 * Re-exports the real `Router`/`RoutingTask`/`RoutingDecision` from
 * `orchestrator/index.ts` — cheapest capable model, switch-cost and
 * prompt-length aware, trivial work kept on the coordinator. `Complexity`
 * (which `RoutingTask` carries) is re-exported once, from `./orchestrator.js`,
 * to keep a single canonical name in the barrel.
 */
export type { Router, RoutingDecision, RoutingTask } from "../orchestrator/index.js";
