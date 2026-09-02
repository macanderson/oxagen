/**
 * Shared typed errors for the subagent fanout handlers.
 *
 * These live in their own dependency-free module so callers on other surfaces
 * (e.g. the apps/api route layer) can `instanceof`-match them WITHOUT importing
 * a full handler module (which would pull in withTenantDb / drizzle / schema).
 *
 * Re-exported from the package root (`@oxagen/agent`) so the import path is the
 * stable public surface, not a deep handler path.
 */

/**
 * Thrown when a subagent fanout cannot be resolved for the given public_id in
 * the current tenant scope — i.e. the swarm/fanout id is unknown, was purged,
 * or belongs to a different org/workspace (cross-tenant). Surfaces (api/mcp)
 * should map this to a 404, NOT a 500.
 *
 * The `code` discriminant lets a surface match it structurally even across a
 * module/package boundary where two copies of the class identity could
 * theoretically exist (bundling edge cases); prefer `instanceof`, fall back to
 * the code.
 */
export class FanoutNotFoundError extends Error {
  readonly code = "fanout_not_found";
  readonly fanoutId: string;
  constructor(fanoutId: string) {
    super(`Fanout ${fanoutId} not found`);
    this.name = "FanoutNotFoundError";
    this.fanoutId = fanoutId;
  }
}

/**
 * Thrown when a subagent child run cannot be resolved for the given public_id
 * in the current tenant scope — unknown, purged, or cross-tenant. Surfaces
 * (api/mcp) should map this to a 404, NOT a 500.
 */
export class SubagentRunNotFoundError extends Error {
  readonly code = "subagent_run_not_found";
  readonly runId: string;
  constructor(runId: string) {
    super(`Subagent run ${runId} not found`);
    this.name = "SubagentRunNotFoundError";
    this.runId = runId;
  }
}

/**
 * Thrown when an agent execution cannot be resolved for the given public_id or
 * UUID in the current tenant scope — unknown, purged, or cross-tenant. Surfaces
 * (api/mcp) should map this to a 404, NOT a 500. Used by agent.trace.get.
 */
export class ExecutionNotFoundError extends Error {
  readonly code = "execution_not_found";
  readonly executionId: string;
  constructor(executionId: string) {
    super(`Execution ${executionId} not found`);
    this.name = "ExecutionNotFoundError";
    this.executionId = executionId;
  }
}

/** Structural type guard — matches across a package boundary via `code`. */
export function isExecutionNotFoundError(
  err: unknown,
): err is ExecutionNotFoundError {
  return (
    err instanceof ExecutionNotFoundError ||
    (err instanceof Error &&
      "code" in err &&
      (err as { code?: unknown }).code === "execution_not_found")
  );
}

/** Structural type guard — see isFanoutNotFoundError for the rationale. */
export function isSubagentRunNotFoundError(
  err: unknown,
): err is SubagentRunNotFoundError {
  return (
    err instanceof SubagentRunNotFoundError ||
    (err instanceof Error &&
      "code" in err &&
      (err as { code?: unknown }).code === "subagent_run_not_found")
  );
}

/** Structural type guard — matches across a package boundary via the `code`
 * discriminant even when `instanceof` would fail on a duplicated class identity. */
export function isFanoutNotFoundError(
  err: unknown,
): err is FanoutNotFoundError {
  return (
    err instanceof FanoutNotFoundError ||
    (err instanceof Error &&
      "code" in err &&
      (err as { code?: unknown }).code === "fanout_not_found")
  );
}
