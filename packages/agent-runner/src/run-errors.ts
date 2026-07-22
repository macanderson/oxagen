/**
 * Typed errors for durable-run admission and hydration
 * (docs/specs/run-evidence-ingress/02-run-attempt-foundation-plan.md, Task 1).
 *
 * These live in their own dependency-free module — no zod, no drizzle, no
 * schema — so a surface (apps/api, the worker, the lease sweeper) can
 * `instanceof`-match them without importing the whole contract module. Same
 * rationale and shape as packages/agent/src/handlers/subagent-errors.ts.
 *
 * Every class carries a stable `code` discriminant. Prefer `instanceof`; the
 * exported guards fall back to `code` so a match still holds across a
 * duplicated class identity (bundling edge cases).
 */

/** One failed field in a rejected spec: dot-delimited path plus the reason. */
export interface RunSpecIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * A `RunSpecV2` (or caller-influence object) failed strict validation. This is
 * the default-deny outcome: admission never repairs a spec, it refuses it.
 * Surfaces should map this to a 400/422, never a 500 — but note that a
 * *trusted* builder hitting this is a server bug, not a caller error, because
 * request bodies can never reach a trusted field in the first place.
 */
export class RunSpecValidationError extends Error {
  readonly code = "run_spec_invalid";
  readonly issues: readonly RunSpecIssue[];

  constructor(message: string, issues: readonly RunSpecIssue[]) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    super(detail ? `${message} (${detail})` : message);
    this.name = "RunSpecValidationError";
    this.issues = issues;
  }
}

/**
 * A caller-influence object carried a trusted section (`actor_binding`,
 * `repository_binding`, …). The type system already forbids this; hitting it
 * at runtime means an `unknown`-typed transport boundary tried to smuggle
 * authority into a run. It is a security event, not a validation nit.
 */
export class UntrustedRunSpecFieldError extends Error {
  readonly code = "run_spec_untrusted_field";
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(
      `Caller influence may not carry trusted run spec fields: ${fields.join(", ")}`,
    );
    this.name = "UntrustedRunSpecFieldError";
    this.fields = fields;
  }
}

/**
 * A persisted spec does not hash to the digest stored alongside it. The spec
 * JSON or the digest column was altered after admission; the run must not
 * execute. Raised by `assertRunSpecV2Digest`.
 */
export class RunSpecDigestMismatchError extends Error {
  readonly code = "run_spec_digest_mismatch";
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Run spec digest mismatch: stored ${expected}, computed ${actual}`);
    this.name = "RunSpecDigestMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** One typed run column that disagrees with the serialized spec. */
export interface RunIdentityMismatch {
  readonly field: string;
  readonly row: unknown;
  readonly spec: unknown;
}

/**
 * The run row's typed security columns disagree with the serialized spec. The
 * worker raises this before materializing an engine or tool: either copy could
 * be the tampered one, so neither is trusted and the run fails closed.
 */
export class RunSpecIdentityMismatchError extends Error {
  readonly code = "run_spec_identity_mismatch";
  readonly mismatches: readonly RunIdentityMismatch[];

  constructor(mismatches: readonly RunIdentityMismatch[]) {
    super(
      `Run row identity disagrees with spec: ${mismatches
        .map((m) => `${m.field} (row=${format(m.row)}, spec=${format(m.spec)})`)
        .join("; ")}`,
    );
    this.name = "RunSpecIdentityMismatchError";
    this.mismatches = mismatches;
  }
}

function format(value: unknown): string {
  return typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value);
}

/**
 * A value that is not RFC 8785-canonicalizable reached a digest input — a
 * float, a non-finite number, `undefined` inside an array, or a non-JSON
 * object (Date, Map, class instance). Canonicalization refuses rather than
 * coercing, because a coerced value digests to something the verifier will
 * never reproduce.
 */
export class CanonicalJsonError extends Error {
  readonly code = "canonical_json_invalid";
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Value at ${path || "<root>"} is not canonicalizable: ${detail}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function hasCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/** Structural type guard — matches across a duplicated class identity. */
export function isRunSpecValidationError(
  err: unknown,
): err is RunSpecValidationError {
  return (
    err instanceof RunSpecValidationError || hasCode(err, "run_spec_invalid")
  );
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isUntrustedRunSpecFieldError(
  err: unknown,
): err is UntrustedRunSpecFieldError {
  return (
    err instanceof UntrustedRunSpecFieldError ||
    hasCode(err, "run_spec_untrusted_field")
  );
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isRunSpecDigestMismatchError(
  err: unknown,
): err is RunSpecDigestMismatchError {
  return (
    err instanceof RunSpecDigestMismatchError ||
    hasCode(err, "run_spec_digest_mismatch")
  );
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isRunSpecIdentityMismatchError(
  err: unknown,
): err is RunSpecIdentityMismatchError {
  return (
    err instanceof RunSpecIdentityMismatchError ||
    hasCode(err, "run_spec_identity_mismatch")
  );
}
