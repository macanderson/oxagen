/**
 * The exact event-type → payload-schema registry for V2 fenced-attempt events
 * (docs/specs/run-evidence-ingress/spec.md; 02-run-attempt-foundation-plan.md,
 * Task 3).
 *
 * A durable V2 event is evidence. Two rules follow, and this module is where
 * both are enforced — BEFORE any SQL is built, so a rejected event never
 * reaches a transaction:
 *
 *  1. **The vocabulary is closed.** An event type that is not in
 *     `EVENT_TYPE_REGISTRY` cannot be appended. There is no "unknown type,
 *     store it anyway" path: an event nobody can interpret is not evidence, and
 *     a producer that invents a type is a producer whose stage coverage cannot
 *     be validated.
 *  2. **An inline payload is allow-listed receipt metadata only.** Every schema
 *     below is `.strict()` and carries digests, public ids, counts, and bounded
 *     enums. Raw source, prompts, diffs, tool/model bodies, command output,
 *     credentials, and embeddings are NEVER inline; they are tenant-encrypted
 *     blobs referenced by `evb_` public id. Three independent checks enforce it:
 *     the recursive forbidden-field scan (`assertNoForbiddenPayloadFields`),
 *     the strict schema, and the 32 KiB post-JCS size cap.
 *
 * ── Digests ────────────────────────────────────────────────────────────────
 *
 * `event_digest` commits to the event's own identity — attempt sequence, schema
 * version, type, stage, payload digest, observed time.
 *
 * `event_stream_digest` commits to the ORDERED
 * `(attempt_seq, event_schema_version, event_type, payload_digest)` tuples and
 * to nothing else (spec.md §"RunEvidenceEnvelopeV1"). Deliberately NOT stage or
 * observed time: those belong to the individual event, and folding them in
 * would make a stream digest un-reproducible from the envelope's own tuple
 * list.
 *
 * It is a CHAINED FOLD, not a digest over a materialized list, because the
 * lease row advances it once per append and never re-reads the whole log
 * (`agent_run_attempt_leases.event_stream_digest`: "Running digest over the
 * ordered … tuples"). `computeEventStreamDigest` is the same fold applied over
 * a whole list, so PR 2's finalizer — which recomputes the digest from the
 * authoritative event log — reproduces the exact bytes the seal committed to.
 * `EMPTY_EVENT_STREAM_DIGEST` is the seed and is also the literal value a
 * zero-event abandoned attempt seals with.
 *
 * The pinned vectors in event-payload-registry.test.ts are the cross-PR
 * contract: if a later change to `canonicalJson` or to the fold shape moves
 * them, the finalizer and the seal disagree and every manifest fails
 * validation. Treat a failing vector as a merge blocker, never as a test to
 * update.
 */
import { z } from "zod";
import {
  canonicalJson,
  digestOfCanonicalJson,
  sha256DigestSchema,
  RESERVED_PUBLIC_ID_PREFIXES,
  type Sha256Digest,
} from "./run-spec-v2";
import {
  ForbiddenEventPayloadFieldError,
  RunEventPayloadTooLargeError,
  RunSpecValidationError,
  UnknownRunEventTypeError,
} from "./run-errors";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * The event-record schema version stamped into `event_schema_version` and into
 * every event/stream digest. A change here is a wire-format change: it moves
 * every digest and must be accompanied by a reader that understands both.
 */
export const EVENT_SCHEMA_VERSION = "agent-run-event/v2";

/**
 * Hard cap on an inline payload, measured on the RFC 8785 canonical UTF-8
 * bytes — not on the producer's own serialization, which could be padded to
 * hide bulk. Anything larger is a blob, not receipt metadata.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 32 * 1024;

/**
 * The nine evidence stages (spec.md §"StageCoverageV1"), mirrored from
 * `packages/database/src/schema/run-evidence-foundation.ts`'s
 * `EVIDENCE_STAGES` and from the `agent_run_events_stage_check` CHECK. Mirrored
 * rather than imported so this module stays free of a schema import in a hot
 * validation path; the drift test pins the two lists together.
 */
export const EVIDENCE_STAGES = [
  "admission",
  "checkout",
  "context",
  "model",
  "tool",
  "change",
  "verification",
  "provider_publish",
  "terminal",
] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

/**
 * Retention content classes. A pinned retention-policy version lists the
 * classes it authorizes retaining exact bytes for
 * (`evidence.retention_policy_versions.retained_content_classes`), so every
 * event type declares which class its referenced payload falls under. This is
 * the "data classification" half of the registry: it decides whether an
 * encrypted payload may be retained at all, independently of whether the event
 * itself is recorded.
 */
export const RETENTION_CONTENT_CLASSES = [
  "admission_receipt",
  "checkout_receipt",
  "context_selection",
  "model_call",
  "tool_call",
  "approval_receipt",
  "change_receipt",
  "verification_receipt",
  "provider_receipt",
  "terminal_receipt",
] as const;
export type RetentionContentClass = (typeof RETENTION_CONTENT_CLASSES)[number];

// ── Local primitive schemas ─────────────────────────────────────────────────
//
// Deliberately local rather than imported from run-spec-v2: that module's
// exported surface is the ADMISSION contract, and widening it with event-shaped
// primitives would blur which schema governs which boundary. The two shapes
// that must not drift (the sha256 digest and the public-id prefixes) ARE
// imported.

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PUBLIC_ID_SUFFIX_RE = /^[0-9a-f]{16,32}$/;
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40}$/;

/** RFC 3339 instant with an explicit zone — a naive timestamp is ambiguous. */
export const observedAtSchema = z
  .string()
  .regex(RFC3339_RE, "expected an RFC 3339 timestamp with an explicit zone")
  .refine((v) => Number.isFinite(Date.parse(v)), "expected a real instant");

function publicIdSchemaFor(prefix: string, label: string) {
  return z.string().refine((value) => {
    const underscore = value.indexOf("_");
    if (underscore <= 0) return false;
    return (
      value.slice(0, underscore + 1) === prefix &&
      PUBLIC_ID_SUFFIX_RE.test(value.slice(underscore + 1))
    );
  }, `expected a ${label} public id (${prefix}<16-32 lowercase hex>)`);
}

/** `evb_` reference to a tenant-encrypted, content-addressed blob. */
export const encryptedBlobRefSchema = publicIdSchemaFor(
  RESERVED_PUBLIC_ID_PREFIXES.evidenceBlob,
  "encrypted blob",
);
const attemptPublicIdSchema = publicIdSchemaFor(
  RESERVED_PUBLIC_ID_PREFIXES.attempt,
  "attempt",
);
const decisionRefSchema = publicIdSchemaFor(
  RESERVED_PUBLIC_ID_PREFIXES.authorizationDecision,
  "authorization decision",
);
const pathLocatorSchema = publicIdSchemaFor(
  RESERVED_PUBLIC_ID_PREFIXES.pathLocator,
  "path locator",
);
const providerObservationSchema = publicIdSchemaFor(
  RESERVED_PUBLIC_ID_PREFIXES.providerObservation,
  "provider observation",
);

const gitObjectIdSchema = z
  .string()
  .regex(GIT_OBJECT_ID_RE, "expected a 40-character lowercase git object id");
const shortLabelSchema = z.string().min(1).max(128);
const reasonCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "expected a lowercase snake_case reason code");
const countSchema = z.number().int().min(0).max(1_000_000);

/**
 * Confidence as integer per-mille (0–1000), never a float. `canonicalJson`
 * refuses non-safe-integer numbers on purpose — the ES6 float-serialization
 * half of RFC 8785 lands with the shared `@oxagen/run-evidence` package — so a
 * float in a digest input would throw at append time rather than digest
 * inconsistently.
 */
const perMilleSchema = z.number().int().min(0).max(1000);

// ── Per-type payload schemas ────────────────────────────────────────────────

const admissionRunAdmittedSchema = z
  .object({
    attempt_public_id: attemptPublicIdSchema,
    attempt_number: z.number().int().min(1),
    max_attempts: z.number().int().min(1),
    spec_digest: sha256DigestSchema,
    authorization_snapshot_digest: sha256DigestSchema,
    grant_ceiling_digest: sha256DigestSchema,
    engine_name: shortLabelSchema,
    engine_version: shortLabelSchema,
    engine_build_digest: sha256DigestSchema,
  })
  .strict();

const localGraphStatusSchema = z.enum(["used", "not_used", "unavailable"]);

const checkoutCompletedSchema = z
  .object({
    provider_repository_id: z.string().min(1).max(256),
    base_commit_sha: gitObjectIdSchema,
    base_tree_sha: gitObjectIdSchema,
    head_commit_sha: gitObjectIdSchema.optional(),
    head_tree_sha: gitObjectIdSchema.optional(),
    // A clean workspace still records the canonical empty digests — these are
    // never omitted to make an incomplete snapshot look clean (spec.md).
    dirty_patch_digest: sha256DigestSchema,
    untracked_manifest_digest: sha256DigestSchema,
    local_graph_status: localGraphStatusSchema,
    local_graph_generation_id: shortLabelSchema.optional(),
    local_graph_schema_version: shortLabelSchema.optional(),
    local_graph_extractor_version: shortLabelSchema.optional(),
    indexed_root_digest: sha256DigestSchema.optional(),
  })
  .strict();

const checkoutUnavailableSchema = z
  .object({
    reason_code: reasonCodeSchema,
    provider_repository_id: z.string().min(1).max(256),
  })
  .strict();

/**
 * The bounded SUMMARY of a context selection. The ordered `FrameUseReceiptV1`
 * array itself is a tenant-encrypted blob (`encrypted_frame_manifest_ref`) —
 * up to `context_policy.max_frames` receipts never belong inline, and
 * `compiled_frame_manifest_digest` is what the manifest commits to.
 */
const contextFramesSelectedSchema = z
  .object({
    query_digest: sha256DigestSchema,
    compiled_frame_manifest_digest: sha256DigestSchema,
    ordered_frame_use_digest: sha256DigestSchema,
    prompt_template_digest: sha256DigestSchema,
    tokenizer_ref: shortLabelSchema,
    frame_count: countSchema,
    token_cost: countSchema,
    encrypted_frame_manifest_ref: encryptedBlobRefSchema.optional(),
    authorization_decision_ref: decisionRefSchema,
  })
  .strict();

const modelOutcomeSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
]);

const modelCallCompletedSchema = z
  .object({
    model_call_id: shortLabelSchema,
    turn_index: z.number().int().min(0).max(100_000),
    provider: shortLabelSchema,
    model: shortLabelSchema,
    provider_request_id: shortLabelSchema.optional(),
    model_policy_decision_ref: decisionRefSchema,
    model_config_digest: sha256DigestSchema,
    system_instruction_digest: sha256DigestSchema,
    message_sequence_digest: sha256DigestSchema,
    tool_schema_digest: sha256DigestSchema,
    ordered_frame_use_digest: sha256DigestSchema,
    outcome: modelOutcomeSchema,
    transmitted_request_body_digest: sha256DigestSchema.optional(),
    response_digest: sha256DigestSchema.optional(),
    error_digest: sha256DigestSchema.optional(),
    encrypted_request_ref: encryptedBlobRefSchema.optional(),
    encrypted_response_ref: encryptedBlobRefSchema.optional(),
    encrypted_error_ref: encryptedBlobRefSchema.optional(),
    input_tokens: countSchema.optional(),
    output_tokens: countSchema.optional(),
  })
  .strict();

const toolCallCompletedSchema = z
  .object({
    tool_call_id: shortLabelSchema,
    capability_name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.]*$/, "expected a lowercase capability name"),
    outcome: z.enum(["completed", "failed", "denied", "cancelled"]),
    input_digest: sha256DigestSchema,
    output_digest: sha256DigestSchema.optional(),
    error_digest: sha256DigestSchema.optional(),
    encrypted_input_ref: encryptedBlobRefSchema.optional(),
    encrypted_output_ref: encryptedBlobRefSchema.optional(),
    authorization_decision_ref: decisionRefSchema,
    approval_receipt_ref: shortLabelSchema.optional(),
    metering_receipt_ref: shortLabelSchema.optional(),
    kernel_trace_ref: shortLabelSchema.optional(),
    duration_ms: countSchema,
  })
  .strict();

const toolApprovalRecordedSchema = z
  .object({
    tool_call_id: shortLabelSchema,
    capability_name: shortLabelSchema,
    decision: z.enum(["approved", "rejected", "expired"]),
    requester_principal_public_id: shortLabelSchema,
    approver_principal_public_id: shortLabelSchema.optional(),
    authorization_decision_ref: decisionRefSchema,
  })
  .strict();

const changeRecordedSchema = z
  .object({
    // Opaque `rpl_` locator — the exact path is never part of the event
    // (spec.md §"Change receipt").
    path_locator_public_id: pathLocatorSchema,
    change_kind: z.enum(["create", "modify", "delete", "rename"]),
    before_digest: sha256DigestSchema.optional(),
    after_digest: sha256DigestSchema.optional(),
    encrypted_patch_ref: encryptedBlobRefSchema.optional(),
    classification_authority: z.enum([
      "runner_observed",
      "provider_observed",
      "inferred",
    ]),
    classification_method: shortLabelSchema,
    classification_input_digest: sha256DigestSchema,
    classification_confidence_per_mille: perMilleSchema.optional(),
  })
  .strict();

const verificationCompletedSchema = z
  .object({
    verification_id: shortLabelSchema,
    method: z.enum(["deterministic", "model_judgment"]),
    command_digest: sha256DigestSchema.optional(),
    environment_digest: sha256DigestSchema.optional(),
    exit_code: z.number().int().min(-256).max(256).optional(),
    output_digest: sha256DigestSchema.optional(),
    encrypted_output_ref: encryptedBlobRefSchema.optional(),
    // `not_run`/`unavailable`/`inconclusive` are explicit — absence never
    // means success (spec.md §"Tool, approval, and verification receipts").
    verdict: z.enum([
      "passed",
      "failed",
      "not_run",
      "unavailable",
      "inconclusive",
    ]),
  })
  .strict();

const providerCommitCreatedSchema = z
  .object({
    provider_observation_public_id: providerObservationSchema.optional(),
    provider_repository_id: z.string().min(1).max(256),
    commit_sha: gitObjectIdSchema,
    tree_sha: gitObjectIdSchema,
    parent_commit_sha: gitObjectIdSchema.optional(),
    changed_file_count: countSchema,
  })
  .strict();

const providerPullRequestOpenedSchema = z
  .object({
    provider_observation_public_id: providerObservationSchema.optional(),
    provider_repository_id: z.string().min(1).max(256),
    pull_request_number: z.number().int().min(1).max(100_000_000),
    head_commit_sha: gitObjectIdSchema,
    // Branch names are annotations, never checkout identity (spec.md).
    head_ref_digest: sha256DigestSchema,
    base_ref_digest: sha256DigestSchema,
  })
  .strict();

const terminalAttemptTerminatedSchema = z
  .object({
    terminal_status: z.enum([
      "completed",
      "failed",
      "cancelled",
      "denied",
      "abandoned",
    ]),
    reason_code: reasonCodeSchema.optional(),
    // An error MESSAGE can carry paths, stdout, or source. Only its digest and
    // an encrypted reference may travel on the event.
    error_digest: sha256DigestSchema.optional(),
    encrypted_error_ref: encryptedBlobRefSchema.optional(),
    result_digest: sha256DigestSchema.optional(),
    encrypted_result_ref: encryptedBlobRefSchema.optional(),
  })
  .strict();

// ── The registry ────────────────────────────────────────────────────────────

export interface EventTypeDefinition {
  /** Which of the nine evidence stages this event proves progress through. */
  readonly stage: EvidenceStage;
  /** Retention class governing whether its exact payload may be retained. */
  readonly contentClass: RetentionContentClass;
  /** Strict schema for an INLINE payload of this type. */
  readonly schema: z.ZodType<unknown>;
}

/**
 * The closed event vocabulary. Ordered by stage, matching execution order —
 * the same rule `SECURITY_EVENT_TYPES` follows in @oxagen/compliance.
 */
export const EVENT_TYPE_REGISTRY = {
  "admission.run_admitted": {
    stage: "admission",
    contentClass: "admission_receipt",
    schema: admissionRunAdmittedSchema,
  },
  "checkout.completed": {
    stage: "checkout",
    contentClass: "checkout_receipt",
    schema: checkoutCompletedSchema,
  },
  "checkout.unavailable": {
    stage: "checkout",
    contentClass: "checkout_receipt",
    schema: checkoutUnavailableSchema,
  },
  "context.frames_selected": {
    stage: "context",
    contentClass: "context_selection",
    schema: contextFramesSelectedSchema,
  },
  "model.call_completed": {
    stage: "model",
    contentClass: "model_call",
    schema: modelCallCompletedSchema,
  },
  "tool.call_completed": {
    stage: "tool",
    contentClass: "tool_call",
    schema: toolCallCompletedSchema,
  },
  "tool.approval_recorded": {
    stage: "tool",
    contentClass: "approval_receipt",
    schema: toolApprovalRecordedSchema,
  },
  "change.recorded": {
    stage: "change",
    contentClass: "change_receipt",
    schema: changeRecordedSchema,
  },
  "verification.completed": {
    stage: "verification",
    contentClass: "verification_receipt",
    schema: verificationCompletedSchema,
  },
  "provider_publish.commit_created": {
    stage: "provider_publish",
    contentClass: "provider_receipt",
    schema: providerCommitCreatedSchema,
  },
  "provider_publish.pull_request_opened": {
    stage: "provider_publish",
    contentClass: "provider_receipt",
    schema: providerPullRequestOpenedSchema,
  },
  "terminal.attempt_terminated": {
    stage: "terminal",
    contentClass: "terminal_receipt",
    schema: terminalAttemptTerminatedSchema,
  },
} as const satisfies Record<string, EventTypeDefinition>;

export type RunEventType = keyof typeof EVENT_TYPE_REGISTRY;

export const RUN_EVENT_TYPES = Object.keys(
  EVENT_TYPE_REGISTRY,
) as readonly RunEventType[];

/** The single terminal event type appended immediately before a seal. */
export const TERMINAL_EVENT_TYPE = "terminal.attempt_terminated" as const;

/** Is `value` a registered event type? Fails BEFORE any SQL is built. */
export function isRunEventType(value: string): value is RunEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPE_REGISTRY, value);
}

/**
 * Look up a type's definition, or throw `UnknownRunEventTypeError`. The throw
 * is the point: an unrecognized type is refused at the contract boundary, so
 * it never reaches a transaction.
 */
export function requireEventTypeDefinition(
  eventType: string,
): EventTypeDefinition {
  if (!isRunEventType(eventType)) {
    throw new UnknownRunEventTypeError(eventType, RUN_EVENT_TYPES);
  }
  return EVENT_TYPE_REGISTRY[eventType];
}

/** The evidence stage a registered event type is stamped with. */
export function stageOfEventType(eventType: string): EvidenceStage {
  return requireEventTypeDefinition(eventType).stage;
}

/** The retention content class a registered event type's payload falls under. */
export function retentionContentClassOf(
  eventType: string,
): RetentionContentClass {
  return requireEventTypeDefinition(eventType).contentClass;
}

/** Does the run's pinned retention policy authorize retaining this payload? */
export function isContentClassRetained(
  eventType: string,
  retainedContentClasses: readonly string[],
): boolean {
  return retainedContentClasses.includes(retentionContentClassOf(eventType));
}

/** A terminal-stage event closes an attempt and precedes its seal. */
export function isTerminalEventType(eventType: string): boolean {
  return (
    isRunEventType(eventType) && stageOfEventType(eventType) === "terminal"
  );
}

// ── Forbidden inline content ────────────────────────────────────────────────

/**
 * Field roots whose RAW value may never travel inline. Each must arrive as a
 * digest and, when retention authorizes it, a tenant-encrypted blob reference
 * (spec.md §"Security and retention rules").
 *
 * The match rule is exact-root or `_`-suffixed-root, so `uri` and `source_uri`
 * are refused while `uri_digest`, `prompt_content_digest`, and
 * `transmitted_request_body_digest` — which carry no raw bytes — are not. A
 * substring rule would have to special-case every legitimate digest field and
 * would fail open the first time someone added one.
 */
export const FORBIDDEN_INLINE_PAYLOAD_ROOTS = [
  "path",
  "uri",
  "url",
  "source",
  "content",
  "prompt",
  "instruction",
  "message",
  "messages",
  "diff",
  "patch",
  "stdout",
  "stderr",
  "output",
  "body",
  "text",
  "credential",
  "credentials",
  "secret",
  "token",
  "apikey",
  "password",
  "embedding",
  "embeddings",
  "vector",
] as const;

const FORBIDDEN_ROOT_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_INLINE_PAYLOAD_ROOTS,
);

/** Is `key` a raw-content field name (exact root, or `<something>_<root>`)? */
export function isForbiddenPayloadKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (FORBIDDEN_ROOT_SET.has(normalized)) return true;
  const underscore = normalized.lastIndexOf("_");
  if (underscore < 0) return false;
  return FORBIDDEN_ROOT_SET.has(normalized.slice(underscore + 1));
}

/**
 * Walk an inline payload and refuse any raw-content field, at ANY depth. Runs
 * BEFORE the strict schema so the failure names the smuggled field rather than
 * reporting a generic unrecognized key, and so a schema that ever grows an
 * open-ended object still cannot carry raw bytes past this point.
 */
export function assertNoForbiddenPayloadFields(
  payload: unknown,
  eventType: string,
): void {
  const offenders: string[] = [];
  walk(payload, "", offenders);
  if (offenders.length > 0) {
    throw new ForbiddenEventPayloadFieldError(eventType, offenders);
  }
}

function walk(value: unknown, path: string, offenders: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walk(item, path ? `${path}.${index}` : String(index), offenders),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const child = path ? `${path}.${key}` : key;
    if (isForbiddenPayloadKey(key)) offenders.push(child);
    walk(item, child, offenders);
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Cheap pre-parse size guard. Measured on `JSON.stringify` (already
 * whitespace-free), which is an upper bound on the canonical bytes of anything
 * a `.strict()` schema will accept. A value that cannot be serialized at all
 * is left to `canonicalJson`, which refuses it with a precise reason.
 */
export function assertInlinePayloadWithinCap(
  eventType: string,
  payload: unknown,
): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return;
  }
  if (serialized === undefined) return;
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > MAX_INLINE_PAYLOAD_BYTES) {
    throw new RunEventPayloadTooLargeError(
      eventType,
      bytes,
      MAX_INLINE_PAYLOAD_BYTES,
    );
  }
}

/** A validated inline payload plus the digest the event row commits to. */
export interface ValidatedInlinePayload {
  readonly eventType: RunEventType;
  readonly stage: EvidenceStage;
  readonly eventSchemaVersion: string;
  readonly payload: unknown;
  readonly payloadDigest: Sha256Digest;
  readonly canonicalBytes: number;
}

/**
 * Validate an inline V2 event payload end to end, in the only order that is
 * safe:
 *
 *   1. registered type      — unknown types fail before anything else;
 *   2. cheap size guard     — refuse bulk before walking or parsing it;
 *   3. forbidden-field scan — names the smuggled raw field precisely;
 *   4. strict schema        — closed shape, bounded values;
 *   5. canonicalize + cap   — the authoritative 32 KiB on the JCS bytes;
 *   6. digest               — over those same canonical bytes.
 *
 * The cap is checked twice against the SAME limit, and neither check is
 * redundant. Step 2 is the cheap early exit — a multi-megabyte payload must not
 * be walked key by key and run through a Zod parse just to be told it is too
 * big — and it is sound because `.strict()` schemas reject unknown keys rather
 * than stripping them. Step 5 is the AUTHORITATIVE one the spec names ("after
 * JCS"): a schema that ever grows a `.default()` produces parsed output the raw
 * input did not contain, so the canonical bytes can exceed what step 2 measured.
 * With today's bounded schemas step 2 always fires first; step 5 is the backstop
 * that stays correct when that stops being true.
 *
 * Every failure throws. There is no "sanitize and continue" path: a payload
 * this function repaired would digest to something the producer cannot
 * reproduce, which is worse than a refusal.
 */
export function validateInlineEventPayload(
  eventType: string,
  payload: unknown,
): ValidatedInlinePayload {
  const definition = requireEventTypeDefinition(eventType);
  assertInlinePayloadWithinCap(eventType, payload);
  assertNoForbiddenPayloadFields(payload, eventType);

  const parsed = definition.schema.safeParse(payload);
  if (!parsed.success) {
    throw new RunSpecValidationError(
      `Invalid ${eventType} event payload`,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  const canonical = canonicalJson(parsed.data);
  const canonicalBytes = new TextEncoder().encode(canonical).length;
  if (canonicalBytes > MAX_INLINE_PAYLOAD_BYTES) {
    throw new RunEventPayloadTooLargeError(
      eventType,
      canonicalBytes,
      MAX_INLINE_PAYLOAD_BYTES,
    );
  }

  return {
    eventType: eventType as RunEventType,
    stage: definition.stage,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    payload: parsed.data,
    payloadDigest: digestOfCanonicalJson(parsed.data),
    canonicalBytes,
  };
}

/**
 * Validate an event whose body is a tenant-encrypted blob. The store never
 * sees the plaintext, so the producer supplies its digest; this checks the
 * reference shape, the digest shape, and that the type is registered.
 */
export function validateEncryptedEventReference(
  eventType: string,
  encryptedPayloadRef: string,
  payloadDigest: string,
): { stage: EvidenceStage; payloadDigest: Sha256Digest } {
  const definition = requireEventTypeDefinition(eventType);
  const ref = encryptedBlobRefSchema.safeParse(encryptedPayloadRef);
  const digest = sha256DigestSchema.safeParse(payloadDigest);
  const issues = [
    ...(ref.success
      ? []
      : ref.error.issues.map((i) => ({
          path: "encrypted_payload_ref",
          message: i.message,
        }))),
    ...(digest.success
      ? []
      : digest.error.issues.map((i) => ({
          path: "payload_digest",
          message: i.message,
        }))),
  ];
  if (issues.length > 0) {
    throw new RunSpecValidationError(
      `Invalid ${eventType} encrypted event reference`,
      issues,
    );
  }
  return {
    stage: definition.stage,
    payloadDigest: digest.data as Sha256Digest,
  };
}

// ── Digests ─────────────────────────────────────────────────────────────────

/** The identity tuple `event_digest` commits to. */
export interface EventDigestInput {
  readonly attemptSeq: number;
  readonly eventSchemaVersion: string;
  readonly eventType: string;
  readonly stage: string;
  readonly payloadDigest: string;
  /** Producer OBSERVATION time (RFC 3339), not the recorded time. */
  readonly observedAt: string;
}

/**
 * `event_digest` over the canonical attempt sequence, schema, type, stage,
 * payload digest, and observed time.
 *
 * `observedAt` is inside the digest, so a producer replaying a batch after a
 * crash MUST resend the original observation time. A re-stamped clock changes
 * the digest and turns a benign replay into a same-sequence/different-digest
 * integrity failure — see `RunEventIntegrityError`.
 */
export function computeEventDigest(input: EventDigestInput): Sha256Digest {
  return digestOfCanonicalJson({
    attempt_seq: input.attemptSeq,
    event_schema_version: input.eventSchemaVersion,
    event_type: input.eventType,
    stage: input.stage,
    payload_digest: input.payloadDigest,
    observed_at: input.observedAt,
  });
}

/**
 * One entry of the ordered stream tuple. EXACTLY the four fields spec.md names
 * — adding a fifth would break every already-sealed attempt's digest.
 */
export interface EventStreamEntry {
  readonly attemptSeq: number;
  readonly eventSchemaVersion: string;
  readonly eventType: string;
  readonly payloadDigest: string;
}

/**
 * The seed of the stream fold, and the literal `event_stream_digest` a
 * zero-event abandoned attempt seals with. A seal must never invent a terminal
 * event just to have something to digest.
 */
export const EMPTY_EVENT_STREAM_DIGEST: Sha256Digest = digestOfCanonicalJson(
  [],
);

/**
 * Advance the running stream digest by one event. Chained so the lease row can
 * carry the digest forward without re-reading the log.
 */
export function advanceEventStreamDigest(
  previous: string,
  entry: EventStreamEntry,
): Sha256Digest {
  return digestOfCanonicalJson({
    previous,
    entry: [
      entry.attemptSeq,
      entry.eventSchemaVersion,
      entry.eventType,
      entry.payloadDigest,
    ],
  });
}

/**
 * The same fold over a whole ordered list — what PR 2's finalizer runs when it
 * recomputes `event_stream_digest` from the authoritative event log. It MUST
 * agree with the incrementally-advanced value the seal committed to.
 */
export function computeEventStreamDigest(
  entries: readonly EventStreamEntry[],
): Sha256Digest {
  return entries.reduce<Sha256Digest>(
    (digest, entry) => advanceEventStreamDigest(digest, entry),
    EMPTY_EVENT_STREAM_DIGEST,
  );
}
