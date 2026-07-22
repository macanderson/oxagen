/**
 * @oxagen/agent-runner — the platform's single seam into the agent engine
 * (agent-engine v2 Phase 1; docs/specs/agent-engine-v2/plan.md, ADR-033).
 *
 * Surfaces import ONLY this package for engine-facing wiring; direct
 * `runCodingAgent`/`runTurn` imports outside it are a review error (the
 * Phase 1 exit criterion). Engine types and constants the surfaces legitimately
 * need are re-exported so the rule is cheap to follow.
 */
export {
  executeTurn,
  executePipelineTurn,
  type PlatformSurface,
} from "./execute-turn";

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

export {
  CanonicalJsonError,
  RunSpecValidationError,
  RunSpecDigestMismatchError,
  RunSpecIdentityMismatchError,
  UntrustedRunSpecFieldError,
  isRunSpecValidationError,
  isRunSpecDigestMismatchError,
  isRunSpecIdentityMismatchError,
  isUntrustedRunSpecFieldError,
  type RunSpecIssue,
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
