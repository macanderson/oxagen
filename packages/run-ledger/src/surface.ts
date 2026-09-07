/**
 * Which platform surface admitted a run. Stamped on the run row so evidence
 * consumers can tell an in-app chat turn from an API turn or an externally
 * attested run. The runner that used to route on this value is gone
 * (ADR-041); the vocabulary stays because the ledger rows carry it.
 *
 * NOTE: `agent_runs_surface_check` in packages/database currently admits only
 * the first four values. `external` — the surface an ADR-041 `client_attested`
 * submission belongs on — needs that CHECK widened before a run can be admitted
 * under it.
 */
export type PlatformSurface =
  | "chat"
  | "api-chat"
  | "a2a"
  | "repo-edit"
  | "external";
