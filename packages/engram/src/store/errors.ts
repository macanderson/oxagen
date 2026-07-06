/**
 * Typed store errors.
 */

/**
 * Thrown when an optional native binding (e.g. `duckdb`) can't be loaded.
 *
 * The store adapters `require()` a native module synchronously in their
 * constructor. A bare `require` failure surfaces as an opaque
 * `Cannot find module 'duckdb'` / `MODULE_NOT_FOUND` that blows up
 * `createStore()` with no indication that the fix is installing the optional
 * dependency. Wrapping it in this typed error means the failure is clear and
 * catchable at construction time, so a caller can degrade to a no-memory mode.
 */
export class NativeModuleUnavailableError extends Error {
  constructor(
    /** The module id that failed to load (e.g. "duckdb"). */
    readonly moduleId: string,
    cause?: unknown,
  ) {
    super(
      `engram store: native module "${moduleId}" is unavailable — install the ` +
        `optional "${moduleId}" dependency (or select a different store adapter). ` +
        `Original error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "NativeModuleUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}
