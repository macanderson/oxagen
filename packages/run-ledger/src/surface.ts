/**
 * Which platform surface admitted a run. Stamped on the run row so evidence
 * consumers can tell an in-app chat turn from an API turn or an externally
 * attested run. The runner that used to route on this value is gone
 * (ADR-043); the vocabulary stays because the ledger rows carry it.
 *
 * `external` is the surface an ADR-043 `client_attested` submission belongs on
 * — an engine Oxagen never hosted, so no interactive surface admitted it.
 * `agent_runs_surface_check` in packages/database admits all five as of
 * 20260907150000_agent_runs_post_runtime.sql.
 */
export type PlatformSurface =
  | "chat"
  | "api-chat"
  | "a2a"
  | "repo-edit"
  | "external";
