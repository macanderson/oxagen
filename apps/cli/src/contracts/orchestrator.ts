/**
 * Coordinator contract surface (pipeline Group 2 — already shipped).
 *
 * Re-exports the real `Coordinator`/`WorkerRequest`/`WorkerResult`/`Complexity`
 * from `orchestrator/index.ts` as the canonical Group 2 contract. The
 * coordinator exposes only coordinator duties — gather context, route,
 * dispatch a worker, request judge feedback, verify work, dispatch a monitor,
 * and do trivial work itself — with no "write code" method, matching the
 * Group 7 hard requirement. `Router`/`RoutingTask`/`RoutingDecision` live in
 * `./router.ts` so they aren't declared twice in the barrel.
 *
 * Note: `Coordinator`'s methods are typed in terms of orchestrator's own
 * shipped interim mirrors of the Group 3/4/5 collaborator shapes
 * (`GraphQueryInput`, `GraphResult`, `JudgeInput`, `JudgeOutput`,
 * `MonitorDispatchInput`, `MonitorDispatchResult`) rather than the fresh stubs
 * in `./context.ts`, `./tools.ts`, and `./monitors.ts`. Those fresh stubs are
 * structurally compatible supersets of orchestrator's mirrors (see the PR's
 * "Reconciliation notes"), so this file deliberately does not re-export those
 * names from `orchestrator/index.ts` — each keeps exactly one canonical name
 * in this barrel, and Group 3/5 implement against `./context.ts` /
 * `./monitors.ts` when they land.
 */
export type { Complexity, Coordinator, WorkerRequest, WorkerResult } from "../orchestrator/index.js";
