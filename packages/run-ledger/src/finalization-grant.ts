/**
 * The one-shot, non-expiring finalization grant and its durable obligation
 * (docs/specs/run-evidence-ingress/spec.md §"Attempt identity" and §"Security
 * and retention rules"; 02-run-attempt-foundation-plan.md, Task 3).
 *
 * Every attempt seal — completed, failed, cancelled, denied, or abandoned —
 * mints exactly one grant and exactly one obligation, in the SAME transaction
 * as the seal. That atomicity is the whole design: a worker that finishes
 * normally and then crashes before finalizing cannot strand its evidence,
 * because the obligation was already durable when the seal committed.
 *
 * Three properties are load-bearing and each is enforced by a database
 * constraint rather than by convention:
 *
 *  - **Exactly one capability.** `capability_id` is CHECK-constrained to
 *    `ingest_run_evidence`. A leaked grant can finalize evidence; it can never
 *    execute a tool.
 *  - **Exactly one attempt, with its committed digests.** The grant copies the
 *    seal's `event_count`, final event digest, and stream digest, so it cannot
 *    be replayed against a different attempt or a different stream.
 *  - **No operational expiry.** There is deliberately no expiry column. The
 *    attempt/seal/digest binding plus one successful consumption are the
 *    limiting authority, so a KMS or blob-storage outage can never strand an
 *    obligation behind a grant that timed out while the outage ran. PR 2
 *    enforces the "one successful consumption" half with its grant-use row.
 *
 * The grant's `afg_` public id is ALSO the evidence envelope's `submission_id`
 * (spec.md §"Validation, idempotency, and failure handling": `(org_id,
 * submission_id)` is the finalization idempotency key). Copying it into the
 * obligation means every retry of that obligation submits under ONE identity
 * instead of forking a new one on each attempt — which is what makes duplicate
 * finalization idempotent rather than duplicative.
 */
import { sql, type SQL } from "drizzle-orm";
import { RESERVED_PUBLIC_ID_PREFIXES } from "./run-spec-v2";

/**
 * The single capability a finalization grant may ever authorize. Mirrors
 * `FINALIZATION_GRANT_CAPABILITY` in
 * packages/database/src/schema/run-evidence-foundation.ts and the
 * `agent_run_finalization_grants_capability_check` CHECK constraint.
 */
export const FINALIZATION_GRANT_CAPABILITY = "ingest_run_evidence";

/**
 * Mint an `afg_` public id. Same shape as every other public id in this repo:
 * a fixed prefix plus 22 hex characters sliced from a UUIDv4 with its dashes
 * stripped — collision-safe without a database round-trip, which matters
 * because this value is generated INSIDE the seal transaction.
 */
export function generateFinalizationGrantPublicId(): string {
  return `${RESERVED_PUBLIC_ID_PREFIXES.finalizationGrant}${crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 22)}`;
}

/** Mint an `arat_` public id for a newly created immutable attempt. */
export function generateAttemptPublicId(): string {
  return `${RESERVED_PUBLIC_ID_PREFIXES.attempt}${crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 22)}`;
}

/**
 * The digests a grant is bound to. `finalEventDigest` is null for a truly
 * zero-event abandoned attempt; `eventStreamDigest` is ALWAYS present (the
 * canonical empty-stream digest in that case), because "no events" is itself a
 * provable claim about the stream.
 */
export interface SealDigests {
  readonly eventCount: number;
  readonly finalEventDigest: string | null;
  readonly eventStreamDigest: string;
}

/** Everything a mint needs, resolved from the sealing transaction's own rows. */
export interface FinalizationGrantInput extends SealDigests {
  readonly publicId: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptPublicId: string;
  readonly sealId: string;
}

/**
 * A sealed attempt's finalization handle — what `sealAttempt` returns and what
 * the obligation worker later presents to `ingest_run_evidence`.
 */
export interface SealedAttemptHandle {
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptPublicId: string;
  readonly sealId: string;
  readonly terminalStatus: string;
  readonly grantId: string;
  /** The `afg_` grant public id. */
  readonly grantPublicId: string;
  /** The grant public id again, under the name the envelope uses. */
  readonly submissionId: string;
  readonly obligationId: string;
  readonly eventCount: number;
  readonly finalEventDigest: string | null;
  readonly eventStreamDigest: string;
  /** True when this seal already existed and the call was a duplicate sweep. */
  readonly alreadySealed: boolean;
}

/**
 * INSERT the immutable grant. No expiry column is written because none exists —
 * see the module comment. `capability_id` is written explicitly rather than
 * left to the column default so the value is visible at the call site and in
 * captured SQL, not implied.
 */
export function buildInsertFinalizationGrantSql(
  input: FinalizationGrantInput,
): SQL {
  return sql`
    INSERT INTO agent.agent_run_finalization_grants (
      public_id, org_id, workspace_id, run_id, attempt_id, seal_id,
      attempt_public_id, capability_id, event_count, final_event_digest,
      event_stream_digest
    )
    VALUES (
      ${input.publicId},
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.runId}::uuid,
      ${input.attemptId}::uuid,
      ${input.sealId}::uuid,
      ${input.attemptPublicId},
      ${FINALIZATION_GRANT_CAPABILITY},
      ${input.eventCount},
      ${input.finalEventDigest},
      ${input.eventStreamDigest}
    )
    RETURNING id, public_id
  `;
}

/**
 * INSERT the durable outbox row, copying the grant's `afg_` public id verbatim
 * into `submission_id`. There is no `processed_at` to write: pending state is
 * derived by anti-joining PR 2's grant-use row, so a crash between "wrote
 * evidence" and "marked done" can neither lose nor duplicate an obligation.
 */
export function buildInsertFinalizationObligationSql(input: {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly grantId: string;
  readonly submissionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly sealId: string;
}): SQL {
  return sql`
    INSERT INTO agent.agent_run_finalization_obligations (
      org_id, workspace_id, grant_id, submission_id, run_id, attempt_id, seal_id
    )
    VALUES (
      ${input.orgId}::uuid,
      ${input.workspaceId}::uuid,
      ${input.grantId}::uuid,
      ${input.submissionId},
      ${input.runId}::uuid,
      ${input.attemptId}::uuid,
      ${input.sealId}::uuid
    )
    RETURNING id
  `;
}

/**
 * Read back an existing seal's grant + obligation. Used only on the duplicate
 * path: a second sweep of an already-sealed attempt must return the SAME
 * handle — the same `submission_id` above all — rather than mint a second
 * grant, which the `_attempt_uq` / `_seal_uq` unique indexes would reject
 * anyway.
 */
export function buildSelectFinalizationHandleSql(attemptId: string): SQL {
  return sql`
    SELECT
      s.id            AS seal_id,
      s.terminal_status,
      s.event_count,
      s.final_event_digest,
      s.event_stream_digest,
      g.id            AS grant_id,
      g.public_id     AS grant_public_id,
      o.id            AS obligation_id,
      o.submission_id
    FROM agent.agent_run_attempt_seals s
    JOIN agent.agent_run_finalization_grants g ON g.seal_id = s.id
    JOIN agent.agent_run_finalization_obligations o ON o.grant_id = g.id
    WHERE s.attempt_id = ${attemptId}::uuid
  `;
}

/** Driver-typed row shape returned by `buildSelectFinalizationHandleSql`. */
export interface FinalizationHandleRow {
  seal_id: string;
  terminal_status: string;
  event_count: number | string;
  final_event_digest: string | null;
  event_stream_digest: string;
  grant_id: string;
  grant_public_id: string;
  obligation_id: string;
  submission_id: string;
}

/** Map an existing seal/grant/obligation join to the returned handle. */
export function mapFinalizationHandleRow(
  row: FinalizationHandleRow,
  identity: { runId: string; attemptId: string; attemptPublicId: string },
): SealedAttemptHandle {
  return {
    runId: identity.runId,
    attemptId: identity.attemptId,
    attemptPublicId: identity.attemptPublicId,
    sealId: row.seal_id,
    terminalStatus: row.terminal_status,
    grantId: row.grant_id,
    grantPublicId: row.grant_public_id,
    submissionId: row.submission_id,
    obligationId: row.obligation_id,
    eventCount: Number(row.event_count),
    finalEventDigest: row.final_event_digest ?? null,
    eventStreamDigest: row.event_stream_digest,
    alreadySealed: true,
  };
}
