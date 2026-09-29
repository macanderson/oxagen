// types.ts: what the evaluators read and what they return.
//
// An evaluator is a pure function of the trace, the fixtures, and the record
// (witness-spec.md). It never spawns a process, reads a file, opens a socket,
// or reads the clock. A contained runtime runs the commands and captures the
// files. The gateway records the tool calls and the usage. The evaluator reads
// what they recorded.
import type { Sha256Digest } from "@oxagen/run-evidence";
import type { DoneReasonCode, OracleClass } from "../types";

/** A JSON value inside a trace or a fixture. */
export type TraceJson =
  | null
  | boolean
  | number
  | string
  | TraceJson[]
  | { [key: string]: TraceJson };

/**
 * Why an oracle rejected a trace. The closed enum from witness-spec.md. A
 * timeout, a crash, or a missing fixture is a rejection with its own code,
 * never a pass.
 */
export const WITNESS_REASONS = [
  "POST_MISMATCH",
  "INVARIANT_BROKEN",
  "POLICY_VIOLATION",
  "BUDGET_EXCEEDED",
  "SCHEMA_INVALID",
  "EXEC_FAILED",
  "DIFF_DISAGREE",
  "PROPERTY_FAILED",
  "REPLAY_DIVERGED",
  "PROVENANCE_MISSING",
  "STRUCTURE_INVALID",
  "NO_CONVERGENCE",
  "FORMAL_UNPROVEN",
  "EVALUATOR_ERROR",
  "FIXTURE_MISSING",
] as const;
export type WitnessReason = (typeof WITNESS_REASONS)[number];

/**
 * The oracle classes with an evaluator on day one. A criterion that names any
 * other class stays held until its evaluator exists.
 */
export const DAY_ONE_ORACLE_CLASSES = [
  "example",
  "predicate",
  "schema",
  "executable",
  "policy",
  "budget",
  "provenance",
] as const satisfies readonly OracleClass[];
export type DayOneOracleClass = (typeof DAY_ONE_ORACLE_CLASSES)[number];

/**
 * Where a stage ran, strongest first. Only `contained` has a call log that
 * Oxagen wrote. The values match ENFORCEMENT_TIERS in the database package's
 * cost schema.
 */
export const ENFORCEMENT_TIERS = [
  "contained",
  "gateway",
  "harness",
  "observe",
] as const;
export type EnforcementTier = (typeof ENFORCEMENT_TIERS)[number];

/**
 * Who counted the calls and the usage. Only `gateway_observed` is a count the
 * worker could not shape. The values match COST_BASES in the database
 * package's cost schema.
 */
export const USAGE_BASES = [
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
] as const;
export type UsageBasis = (typeof USAGE_BASES)[number];

/** One tool call as the gateway recorded it. */
export interface ToolCallRecord {
  tool: string;
  input: TraceJson;
}

/** The usage counters the gateway recorded. `usd` is null when no cost was reported. */
export interface UsageRecord {
  usd: number | null;
  tokens: number;
  toolCalls: number;
  minutes: number;
  retries: number;
  stopAttempts: number;
}

/**
 * What the gateway recorded for a stage, or for several stages merged. Tool
 * calls and budgets come from here and nowhere else. A log the worker wrote
 * has no place in this type.
 */
export interface GatewayRecords {
  tier: EnforcementTier;
  basis: UsageBasis;
  toolCalls: readonly ToolCallRecord[];
  usage: UsageRecord;
}

/** What a runtime recorded when it ran one command. */
export interface RunRecord {
  /** Null when the process never exited on its own. */
  exitCode: number | null;
  /** The signal that ended the process, when one did. */
  signal?: string;
  durationS: number;
  stdout: Sha256Digest;
  stderr: Sha256Digest;
}

/** One file as the runtime captured it at the head of the work. */
export interface FileRecord {
  sha256: Sha256Digest;
  /** The file's text, when the runtime captured it. `contains` needs it. */
  text?: string;
}

/** The diff manifest: every changed or new file against the base. */
export interface DiffRecord {
  base: string;
  files: readonly string[];
}

/** A chunk the run retrieved, by id and content hash. */
export interface RetrievedChunk {
  id: string;
  sha256: Sha256Digest;
}

/** A citation in the output. It must resolve to a retrieved chunk. */
export interface CitationRecord {
  chunk: string;
  sha256: Sha256Digest;
}

/** An artifact the run produced, with the hashes of what it was made from. */
export interface ArtifactRecord {
  id: string;
  sha256: Sha256Digest;
  inputs: readonly Sha256Digest[];
}

/** What a runtime captured, without the gateway's records. */
export interface TraceFacts {
  /** Commands the runtime ran, keyed by the exact command string. */
  runs: Readonly<Record<string, RunRecord>>;
  /** Files at the head of the work, keyed by repository path. */
  files: Readonly<Record<string, FileRecord>>;
  diff?: DiffRecord;
  /** Named outputs, for the example and schema oracles. */
  outputs: Readonly<Record<string, TraceJson>>;
  /** The captured end state, for the predicate oracle. */
  snapshot?: TraceJson;
  retrieved: readonly RetrievedChunk[];
  citations: readonly CitationRecord[];
  artifacts: readonly ArtifactRecord[];
}

/** Everything an evaluator reads about the work. */
export interface Trace extends TraceFacts {
  gateway: GatewayRecords;
}

/** Concrete output against an expected value, by structural equality or by digest. */
export interface ExampleFixture {
  class: "example";
  output: string;
  expected?: TraceJson;
  /** The JCS SHA-256 of the expected value, when the value itself is not stored. */
  expectedDigest?: Sha256Digest;
}

/** One assertion over the snapshot, at an RFC 6901 JSON pointer. */
export interface PredicateAssertion {
  path: string;
  equals?: TraceJson;
  /** The array at the path has exactly this many items. */
  count?: number;
  /** False asserts the path is absent. Otherwise the path must be present. */
  exists?: boolean;
}

export interface PredicateFixture {
  class: "predicate";
  assertions: readonly PredicateAssertion[];
}

/** A named output conforms to a JSON Schema (draft 2020-12). */
export interface SchemaFixture {
  class: "schema";
  output: string;
  schema: { [key: string]: TraceJson } | boolean;
}

/** A pinned command exits zero inside its timeout. */
export interface ExecutableFixture {
  class: "executable";
  command: string;
  timeout_s?: number;
}

/** Every tool call is inside the capability set. Rules use the tools check syntax. */
export interface PolicyFixture {
  class: "policy";
  capabilities: readonly string[];
}

export interface BudgetLimits {
  usd?: number;
  tokens?: number;
  minutes?: number;
  tool_calls?: number;
  retries?: number;
}

export interface BudgetFixture {
  class: "budget";
  limits: BudgetLimits;
}

/** The pre-state hashes an artifact may chain to, besides retrieved chunks. */
export interface ProvenanceFixture {
  class: "provenance";
  inputs?: readonly Sha256Digest[];
}

export type OracleFixture =
  | ExampleFixture
  | PredicateFixture
  | SchemaFixture
  | ExecutableFixture
  | PolicyFixture
  | BudgetFixture
  | ProvenanceFixture;

/** The fixtures for one criterion. */
export interface CriterionFixtures {
  oracle?: OracleFixture;
  /**
   * The trace the criterion must reject, as parts that replace the trace's
   * own. Required when the criterion names a negative.
   */
  negative?: Partial<Trace>;
}

/** Fixtures keyed by criterion id. */
export type Fixtures = Readonly<Record<string, CriterionFixtures>>;

/** What a check evaluator returns. `reason` is set when `ok` is false. */
export interface CheckResult {
  ok: boolean;
  evidence: Sha256Digest;
  error?: true;
  reason?: DoneReasonCode;
}

/** What an oracle evaluator returns. `reason` is set when `ok` is false. */
export interface OracleResult {
  ok: boolean;
  evidence: Sha256Digest;
  error?: true;
  reason?: WitnessReason;
}
