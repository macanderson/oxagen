/**
 * @oxagen/agent-runner — the platform's single seam into the agent engine
 * (agent-engine v2 Phase 1; docs/specs/agent-engine-v2/plan.md, ADR-033).
 *
 * Surfaces import ONLY this package for engine-facing wiring; direct
 * `runTurn` imports outside it are a review error (the
 * Phase 1 exit criterion). Engine types and constants the surfaces legitimately
 * need are re-exported so the rule is cheap to follow.
 */
export {
  executeTurn,
  executePipelineTurn,
  type ExecuteTurnOptions,
  type PlatformSurface,
} from "./execute-turn";

// Phase C — the engine vocabulary (docs/specs/agent-engine-v2/plan.md).
// Deliberately ONLY the flag-resolution half, which is pure. The Stella
// adapter itself lives behind the `@oxagen/agent-runner/stella` subpath and is
// NOT re-exported here: it reaches for `node:child_process`, `node:crypto` and
// `node:fs` to supervise sidecar processes, and this barrel is imported by
// `apps/app`, whose bundler must not be handed those through a path it can
// reach statically. `executeTurn` loads the adapter with a dynamic import, so
// a deployment on the TS engine never pulls it in at all.
export {
  DEFAULT_ENGINE,
  ENGINE_ENV_VAR,
  isEngineChoice,
  resolveEngineChoice,
  UnknownEngineError,
  type EngineChoice,
} from "./stella/engine-choice";

// Phase 2b — durable-run persistence (docs/specs/agent-engine-v2/plan.md,
// Phase 2). run-store.ts is the only writer of agent.agent_runs /
// agent.agent_run_events; surfaces and the worker pool both go through this
// seam rather than issuing their own SQL against those tables.
export {
  createPostgresRunStore,
  MAX_RUN_ATTEMPTS,
  RUN_LEASE_SECONDS,
  type RunStore,
  type EnqueueRunInput,
  type ClaimedRun,
  type RunEventRecord,
  type RunSummary,
} from "./run-store";

// Fenced immutable attempts (PR 1A Task 3). The V2 surface is a SEPARATE
// interface from `RunStore` so existing V1 callers keep compiling unchanged;
// `createPostgresRunStore()` returns `RunStore & AttemptRunStore`.
export {
  DEFAULT_RECLAIM_LIMIT,
  EVENT_SEQUENCE_CONFLICT_EVENT,
  ATTEMPT_TERMINAL_STATUSES,
  generateLeaseToken,
  generateAttemptPublicId,
  buildRunRowIdentityFromSpec,
  mapRunV2IdentityRow,
  mapClaimedRunV2,
  mapAttemptEventReadRow,
  prepareAttemptEvent,
  planAttemptBatch,
  reconcileReplayedEvents,
  foldAttemptStreamDigest,
  leaseRejectionReason,
  assertLeaseUsable,
  runStatusForTerminal,
  type AttemptRunStore,
  type EnqueueRunV2Input,
  type ClaimNextRunV2Options,
  type ClaimedRunV2,
  type ClaimedRunV2Detail,
  type RunLeaseRef,
  type ResolvedEngineIdentity,
  type RestoredCheckpointRef,
  type AttemptEventInput,
  type AttemptCheckpointInput,
  type AppendAttemptBatchInput,
  type AppendAttemptBatchResult,
  type AppendedAttemptEvent,
  type AttemptEventReadRecord,
  type AttemptTerminalStatus,
  type SealAttemptInput,
  type ReclaimExpiredAttemptsOptions,
  type ReclaimedAttempt,
  type RunSecurityEventSink,
  type RunStoreOptions,
  type PreparedAttemptEvent,
  type AttemptBatchPlan,
  type LockedLeaseRow,
  type ExistingAttemptEventRow,
  type RunV2IdentityRow,
} from "./run-store";

// The closed V2 event vocabulary plus the digest contract PR 2's finalizer
// must reproduce byte for byte.
export {
  EVENT_SCHEMA_VERSION,
  MAX_INLINE_PAYLOAD_BYTES,
  EVIDENCE_STAGES,
  RETENTION_CONTENT_CLASSES,
  EVENT_TYPE_REGISTRY,
  RUN_EVENT_TYPES,
  TERMINAL_EVENT_TYPE,
  FORBIDDEN_INLINE_PAYLOAD_ROOTS,
  EMPTY_EVENT_STREAM_DIGEST,
  encryptedBlobRefSchema,
  observedAtSchema,
  isRunEventType,
  requireEventTypeDefinition,
  stageOfEventType,
  retentionContentClassOf,
  isContentClassRetained,
  isTerminalEventType,
  isForbiddenPayloadKey,
  assertNoForbiddenPayloadFields,
  validateInlineEventPayload,
  validateEncryptedEventReference,
  computeEventDigest,
  advanceEventStreamDigest,
  computeEventStreamDigest,
  type EvidenceStage,
  type RetentionContentClass,
  type EventTypeDefinition,
  type RunEventType,
  type ValidatedInlinePayload,
  type EventDigestInput,
  type EventStreamEntry,
} from "./event-payload-registry";

// The one-shot, non-expiring finalization grant minted atomically with every
// seal, and the durable obligation that guarantees its evidence is submitted.
export {
  FINALIZATION_GRANT_CAPABILITY,
  generateFinalizationGrantPublicId,
  buildInsertFinalizationGrantSql,
  buildInsertFinalizationObligationSql,
  buildSelectFinalizationHandleSql,
  mapFinalizationHandleRow,
  type SealDigests,
  type FinalizationGrantInput,
  type FinalizationHandleRow,
  type SealedAttemptHandle,
} from "./finalization-grant";

// Run/attempt evidence foundation (PR 1A Task 1;
// docs/specs/run-evidence-ingress/spec.md). RunSpecV2 is the trusted admission
// contract — built ONLY by server code, never from a request body. Surfaces
// parse caller input with `parseCallerRunInfluence` and hand the result to
// `buildTrustedRunSpecV2` alongside separately-resolved trusted sections.
export {
  // primitives
  canonicalJson,
  digestOfCanonicalJson,
  assertSha256Digest,
  assertDecimalGeneration,
  RESERVED_PUBLIC_ID_PREFIXES,
  RUN_ENGINES,
  REPOSITORY_PROVIDERS,
  TOOL_RISK_LEVELS,
  MAX_RUN_ATTEMPTS_CEILING,
  MAX_RUN_STEPS_CEILING,
  TRUSTED_RUN_SPEC_SECTIONS,
  // schemas
  runSpecV2Schema,
  generalRunSpecV2Schema,
  repoEditRunSpecV2Schema,
  enginePolicySchema,
  actorBindingSchema,
  authorizationSnapshotRefSchema,
  denyGenerationVectorSchema,
  repositoryBindingSchema,
  workspacePolicySchema,
  contextPolicySchema,
  toolPolicySchema,
  outputPolicySchema,
  callerRunInfluenceSchema,
  callerRunPreferencesSchema,
  sha256DigestSchema,
  decimalGenerationSchema,
  repositoryBindingPublicIdSchema,
  retentionPolicyPublicIdSchema,
  // parsers / builders / comparators
  parseRunSpecV2,
  parseCallerRunInfluence,
  buildTrustedRunSpecV2,
  runSpecV2Digest,
  assertRunSpecV2Digest,
  compareRunRowIdentity,
  assertRunRowMatchesSpec,
  type RunSpecV2,
  type RunSpecV2Input,
  type GeneralRunSpecV2,
  type RepoEditRunSpecV2,
  type TrustedRunSpecV2Input,
  type TrustedRunSpecSection,
  type CallerRunInfluence,
  type ParsedCallerRunInfluence,
  type RunRowIdentity,
  type RunIdentityMismatch,
  type RepositoryBinding,
  type AuthorizationSnapshotRef,
  type RepositoryBindingPublicId,
  type RetentionPolicyPublicId,
  type ReservedPublicIdKind,
  type Sha256Digest,
  type DecimalGeneration,
} from "./run-spec-v2";

// The RETAINED legacy admission contract (PR 1A Task 6). Centralized here so
// the enqueue side (apps/api's /runs POST) and the claim side (@oxagen/agent's
// turn driver) share ONE definition while queued v1 work drains. v1 rows are
// explicitly NON-EVIDENCE — see the module doc; they are never promoted to v2.
export {
  LEGACY_RUN_SPEC_VERSION,
  LEGACY_CODE_MODE_SURFACES,
  isLegacyCodeModeSurface,
  runSpecV1Schema,
  parseRunSpecV1,
  buildLegacyRunSpecV1,
  type RunSpecV1,
  type LegacyToolPolicy,
  type LegacyRunSpecV1Input,
} from "./run-spec-v1-legacy";

export {
  CanonicalJsonError,
  RunSpecValidationError,
  RunSpecDigestMismatchError,
  RunSpecIdentityMismatchError,
  UntrustedRunSpecFieldError,
  UnknownRunEventTypeError,
  ForbiddenEventPayloadFieldError,
  RunEventPayloadTooLargeError,
  RunEventIntegrityError,
  RunEventSequenceGapError,
  RunLeaseFencedError,
  RunStoreStateError,
  isRunSpecValidationError,
  isRunSpecDigestMismatchError,
  isRunSpecIdentityMismatchError,
  isUntrustedRunSpecFieldError,
  isUnknownRunEventTypeError,
  isForbiddenEventPayloadFieldError,
  isRunEventPayloadTooLargeError,
  isRunEventIntegrityError,
  isRunEventSequenceGapError,
  isRunLeaseFencedError,
  isRunStoreStateError,
  type RunSpecIssue,
  type LeaseRejectionReason,
} from "./run-errors";

// Re-exports so surfaces don't need a second engine-facing import. Types are
// pass-throughs; the constants are advertised limits, not engine behavior.
export {
  DEFAULT_AGENT_MODEL,
  DEFAULT_MAX_AGENT_STEPS,
} from "@oxagen/agent-engine";
export type {
  RunCodingAgentOptions,
  RunCodingAgentResult,
  RunTurnOptions,
  RunTurnResult,
  CodingEvent,
} from "@oxagen/agent-engine";
