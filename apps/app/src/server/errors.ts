// Typed server errors with a stable `code`, and the one mapping from a thrown
// write failure to the state a server action returns.
//
// Each class names one failure a caller can act on. `code` is a stable wire
// identifier (it reaches message catalogs and e2e assertions); `status` is the
// HTTP status a route handler answers with. Anything that is not one of these,
// not a kernel CapabilityError and not a coded error is rethrown untouched:
// Next's redirect()/notFound() interrupts travel as thrown errors and must reach
// the framework, and an unknown failure belongs to onRequestError, not to a
// toast.

export type AppErrorCode =
  | "fixture_write_refused"
  | "tool_not_registered"
  | "contract_output_mismatch"
  | "invalid_stream_cursor"
  | "cache_tag_scope";

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  abstract readonly status: number;
}

/**
 * A write attempted while the app runs on the fixture data source.
 *
 * Fixture mode (MC_DATA=fixture, never in a production build) skips the IAM,
 * billing, entitlement and decision-rules bootstraps in instrumentation.ts,
 * because it has no Postgres. A kernel `invoke()` there would run with no IAM
 * runtime and fall open, so the write seam refuses before the kernel is reached.
 */
export class FixtureWriteRefused extends AppError {
  readonly code = "fixture_write_refused";
  readonly status = 409;

  constructor(readonly tool: string) {
    super(
      `agent tool "${tool}" was not invoked: the app is running on the fixture data source, where the kernel's IAM gate is not bootstrapped`,
    );
    this.name = "FixtureWriteRefused";
  }
}

/** The contract handed to invokeTool is not registered with the kernel. */
export class ToolNotRegistered extends AppError {
  readonly code = "tool_not_registered";
  readonly status = 500;

  constructor(readonly tool: string) {
    super(`agent tool not registered: ${tool}`);
    this.name = "ToolNotRegistered";
  }
}

/**
 * A tool returned a value its own contract's output schema rejects. The value
 * is never handed to the caller: a cast would let a wrong shape reach the UI.
 */
export class ContractOutputMismatch extends AppError {
  readonly code = "contract_output_mismatch";
  readonly status = 502;

  constructor(
    readonly tool: string,
    readonly issues: readonly unknown[],
  ) {
    super(
      `agent tool "${tool}" returned output that does not match its contract (${String(issues.length)} issue(s))`,
    );
    this.name = "ContractOutputMismatch";
  }
}

/** An SSE cursor (`Last-Event-ID` or `after`) that is not a decimal run_seq. */
export class InvalidStreamCursor extends AppError {
  readonly code = "invalid_stream_cursor";
  readonly status = 400;

  constructor(readonly cursor: string) {
    super(`stream cursor must be a non-negative decimal sequence`);
    this.name = "InvalidStreamCursor";
  }
}

/** A cache tag built from a scope that cannot own it (see cache-tags.ts). */
export class CacheTagScopeError extends AppError {
  readonly code = "cache_tag_scope";
  readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = "CacheTagScopeError";
  }
}

/** What a server action returns when a write fails in a way the page can show. */
export type ActionFailure = {
  ok: false;
  code: string;
  status: number;
  /** Set for an IAM denial: the tool the viewer lacks permission for. */
  permission?: string;
  /** Set for a pending approval: the access request the caller can poll. */
  accessRequestId?: string;
};

/**
 * HTTP status per kernel CapabilityError code. Kept as data so a new kernel
 * code is a one-line change and the test enumerates the table.
 */
export const CAPABILITY_ERROR_STATUS: Readonly<Record<string, number>> = {
  unknown_capability: 500,
  no_handler: 500,
  surface_denied: 403,
  authz_denied: 403,
  pending_approval: 202,
  invalid_input: 422,
  invalid_output: 502,
  capability_not_installed: 403,
  lifecycle_not_allowed: 409,
  lifecycle_event_denied: 409,
  lifecycle_context_invalid: 409,
  lifecycle_recursion_denied: 409,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The kernel's CapabilityError, recognised by shape rather than `instanceof`:
 * a bundler can evaluate @oxagen/oxagen twice (RSC and SSR graphs), and an
 * instanceof check against the other copy's class silently fails.
 */
function asCapabilityError(
  err: unknown,
): { capability: string; code: string; accessRequestId?: string } | null {
  if (!(err instanceof Error) || err.name !== "CapabilityError") return null;
  const e = err as unknown as Record<string, unknown>;
  if (typeof e.capability !== "string" || typeof e.code !== "string")
    return null;
  return {
    capability: e.capability,
    code: e.code,
    ...(typeof e.accessRequestId === "string"
      ? { accessRequestId: e.accessRequestId }
      : {}),
  };
}

/**
 * Map a failed write to the state a server action returns, or rethrow.
 *
 * Handled: AppError subclasses, kernel CapabilityErrors, and any error carrying
 * a string `code` with a numeric `status` (the billing gate's 402, for one).
 * Everything else is rethrown, including Next navigation interrupts.
 */
export function toActionFailure(err: unknown): ActionFailure {
  if (err instanceof AppError) {
    return { ok: false, code: err.code, status: err.status };
  }
  const cap = asCapabilityError(err);
  if (cap) {
    const status = CAPABILITY_ERROR_STATUS[cap.code] ?? 500;
    const failure: ActionFailure = { ok: false, code: cap.code, status };
    if (cap.code === "authz_denied" || cap.code === "surface_denied")
      failure.permission = cap.capability;
    if (cap.accessRequestId) failure.accessRequestId = cap.accessRequestId;
    return failure;
  }
  if (
    err instanceof Error &&
    isRecord(err) &&
    typeof err.code === "string" &&
    typeof err.status === "number" &&
    Number.isInteger(err.status) &&
    err.status >= 400 &&
    err.status < 600
  ) {
    return { ok: false, code: err.code, status: err.status };
  }
  throw err;
}
