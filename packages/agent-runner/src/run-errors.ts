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

// ── Fenced-attempt event errors (Task 3) ────────────────────────────────────

/**
 * A producer named an event type that is not in the closed registry. Refused at
 * the contract boundary, BEFORE any SQL is built: an event nobody can interpret
 * is not evidence, and its stage coverage could never be validated.
 */
export class UnknownRunEventTypeError extends Error {
  readonly code = "run_event_type_unknown";
  readonly eventType: string;
  readonly knownTypes: readonly string[];

  constructor(eventType: string, knownTypes: readonly string[]) {
    super(
      `Unknown run event type "${eventType}" (known: ${knownTypes.join(", ")})`,
    );
    this.name = "UnknownRunEventTypeError";
    this.eventType = eventType;
    this.knownTypes = knownTypes;
  }
}

/**
 * An inline payload carried a raw `path`, `uri`, `content`, `prompt`, `diff`,
 * `stdout`/`stderr`, model/tool body, credential, or embedding field. Those
 * values must be tenant-encrypted blobs referenced by `evb_` public id; putting
 * them inline would land source, prompts, or secrets in a Postgres column that
 * is mirrored to telemetry.
 */
export class ForbiddenEventPayloadFieldError extends Error {
  readonly code = "run_event_payload_forbidden_field";
  readonly eventType: string;
  readonly fields: readonly string[];

  constructor(eventType: string, fields: readonly string[]) {
    super(
      `Inline payload for "${eventType}" carries raw content fields that must be ` +
        `encrypted blob references: ${fields.join(", ")}`,
    );
    this.name = "ForbiddenEventPayloadFieldError";
    this.eventType = eventType;
    this.fields = fields;
  }
}

/** An inline payload exceeded the post-JCS byte cap — it belongs in a blob. */
export class RunEventPayloadTooLargeError extends Error {
  readonly code = "run_event_payload_too_large";
  readonly eventType: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(eventType: string, bytes: number, limit: number) {
    super(
      `Inline payload for "${eventType}" is ${bytes} canonical bytes, over the ` +
        `${limit}-byte cap; use an encrypted payload reference instead`,
    );
    this.name = "RunEventPayloadTooLargeError";
    this.eventType = eventType;
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * The same `(attempt_id, attempt_seq)` was written twice with DIFFERENT event
 * digests. This is the failure `ON CONFLICT DO NOTHING` used to hide: one of
 * the two writers observed a different execution, so the ordered stream is no
 * longer a single provable history.
 *
 * It is a hard error AND a security event (`agent_run.event_sequence_conflict`,
 * emitted outside the rolled-back transaction so the audit record survives).
 * Note that a producer which re-stamps `observed_at` on a replayed batch
 * inflicts this on itself — the observed time is inside `event_digest`.
 */
export class RunEventIntegrityError extends Error {
  readonly code = "run_event_integrity_conflict";
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly storedDigest: string;
  readonly incomingDigest: string;

  constructor(
    attemptId: string,
    attemptSeq: number,
    storedDigest: string,
    incomingDigest: string,
  ) {
    super(
      `Event sequence conflict on attempt ${attemptId} seq ${attemptSeq}: ` +
        `stored ${storedDigest}, incoming ${incomingDigest}`,
    );
    this.name = "RunEventIntegrityError";
    this.attemptId = attemptId;
    this.attemptSeq = attemptSeq;
    this.storedDigest = storedDigest;
    this.incomingDigest = incomingDigest;
  }
}

/**
 * A batch's attempt sequences were not contiguous, did not start where the
 * lease left off, or skipped ahead. `attempt_seq` is producer-assigned and
 * dense from 1; a gap means events were lost before they were ever durable,
 * and accepting the batch would silently ratify that loss.
 */
export class RunEventSequenceGapError extends Error {
  readonly code = "run_event_sequence_gap";
  readonly attemptId: string;
  readonly expectedSeq: number;
  readonly receivedSeq: number;

  constructor(attemptId: string, expectedSeq: number, receivedSeq: number) {
    super(
      `Non-contiguous attempt sequence on attempt ${attemptId}: expected ` +
        `${expectedSeq}, received ${receivedSeq}`,
    );
    this.name = "RunEventSequenceGapError";
    this.attemptId = attemptId;
    this.expectedSeq = expectedSeq;
    this.receivedSeq = receivedSeq;
  }
}

/**
 * The reason a fenced operation was refused. Every value is terminal for the
 * attempt that hit it — the worker stops immediately and performs no cleanup
 * mutation beyond local process shutdown.
 */
export type LeaseRejectionReason =
  | "unknown_lease"
  | "token_mismatch"
  | "epoch_mismatch"
  | "expired"
  | "fenced"
  | "sealed";

/**
 * A renew/append/checkpoint/cancel-check/seal was attempted without a valid
 * claim on the attempt. Raised rather than returned as `false` because, unlike
 * V1's benign "lost the row" race, a fenced V2 attempt writing again would be
 * appending to evidence another attempt now owns.
 */
export class RunLeaseFencedError extends Error {
  readonly code = "run_lease_fenced";
  readonly attemptId: string;
  readonly reason: LeaseRejectionReason;

  constructor(attemptId: string, reason: LeaseRejectionReason) {
    super(`Attempt ${attemptId} may not write: ${reason}`);
    this.name = "RunLeaseFencedError";
    this.attemptId = attemptId;
    this.reason = reason;
  }
}

/**
 * A V2 admission or claim could not proceed because trusted state was missing
 * or self-inconsistent (an absent run row, a checkpoint referencing an unknown
 * attempt, a claim whose pinned `max_attempts` is already exhausted). Always
 * fail-closed: the run does not execute.
 */
export class RunStoreStateError extends Error {
  readonly code = "run_store_state_invalid";
  readonly detail: string;

  constructor(detail: string) {
    super(`Run store state invalid: ${detail}`);
    this.name = "RunStoreStateError";
    this.detail = detail;
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

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isUnknownRunEventTypeError(
  err: unknown,
): err is UnknownRunEventTypeError {
  return (
    err instanceof UnknownRunEventTypeError ||
    hasCode(err, "run_event_type_unknown")
  );
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isForbiddenEventPayloadFieldError(
  err: unknown,
): err is ForbiddenEventPayloadFieldError {
  return (
    err instanceof ForbiddenEventPayloadFieldError ||
    hasCode(err, "run_event_payload_forbidden_field")
  );
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isRunEventPayloadTooLargeError(
  err: unknown,
): err is RunEventPayloadTooLargeError {
  return (
    err instanceof RunEventPayloadTooLargeError ||
    hasCode(err, "run_event_payload_too_large")
  );
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isRunEventIntegrityError(
  err: unknown,
): err is RunEventIntegrityError {
  return (
    err instanceof RunEventIntegrityError ||
    hasCode(err, "run_event_integrity_conflict")
  );
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isRunEventSequenceGapError(
  err: unknown,
): err is RunEventSequenceGapError {
  return (
    err instanceof RunEventSequenceGapError ||
    hasCode(err, "run_event_sequence_gap")
  );
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isRunLeaseFencedError(
  err: unknown,
): err is RunLeaseFencedError {
  return err instanceof RunLeaseFencedError || hasCode(err, "run_lease_fenced");
}

/** Structural type guard — see isRunSpecValidationError for the rationale. */
export function isRunStoreStateError(err: unknown): err is RunStoreStateError {
  return (
    err instanceof RunStoreStateError || hasCode(err, "run_store_state_invalid")
  );
}
