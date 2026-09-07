/**
 * Typed errors for the execution-trace handlers.
 *
 * These live in their own dependency-free module so callers on other surfaces
 * (e.g. the apps/api route layer) can `instanceof`-match them WITHOUT importing
 * a full handler module (which would pull in withTenantDb / drizzle / schema).
 *
 * Re-exported from the package root (`@oxagen/agent`) so the import path is the
 * stable public surface, not a deep handler path.
 */

/**
 * Thrown when an agent execution cannot be resolved for the given public_id or
 * UUID in the current tenant scope — unknown, purged, or cross-tenant. Surfaces
 * (api/mcp) should map this to a 404, NOT a 500. Used by `get_execution_trace`
 * and `debug_execution`.
 *
 * The `code` discriminant lets a surface match it structurally even across a
 * module/package boundary where two copies of the class identity could
 * theoretically exist (bundling edge cases); prefer `instanceof`, fall back to
 * the code.
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
