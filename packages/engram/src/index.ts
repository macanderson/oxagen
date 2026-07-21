/**
 * @oxagen/engram — Memory substrate for the Oxagen agent platform.
 *
 * Public API surface. All consumers import from this barrel.
 */

// Hash (SHA-256 content addressing)
export { initHash, contentHash } from "./hash";

// Canonical JSON serialization for content-address hashing (sorted keys)
export { canonicalStringify } from "./canonical-json";

// Core types
export type {
  RecordKind,
  Namespace,
  Provenance,
  EpisodicBody,
  SemanticBody,
  ProceduralBody,
  EntityBody,
  EdgeBody,
  RecordBody,
  MemoryRecord,
  WriteOpts,
} from "./types";

export {
  RecordKindSchema,
  NamespaceSchema,
  ProvenanceSchema,
  EpisodicBodySchema,
  SemanticBodySchema,
  ProceduralBodySchema,
  EntityBodySchema,
  EdgeBodySchema,
  MemoryRecordSchema,
} from "./types";

// Record creation and content addressing
export { createRecord, computeRecordId, verifyRecordIntegrity } from "./record";
export type { CreateRecordParams } from "./record";

// Namespace utilities
export {
  validateNamespace,
  namespaceKey,
  isWithinNamespace,
  workspaceNamespace,
  sessionNamespace,
  NamespaceScopeError,
} from "./namespace";

// Salience
export { computeSalience } from "./salience";

// Store
export { createStore } from "./store/index";
export type { EpisodicStore, EpisodicQuery } from "./store/episodic";
export type { StoreConfig } from "./store/index";

// Write API
export { remember } from "./api/remember";
export { assert } from "./api/assert";
export { relate } from "./api/relate";
export { pin, unpin } from "./api/pin";

// Migration
export { migrateMemories, convertLegacyRow } from "./migration/neo4j-to-engram";
export type {
  MigrationResult,
  MigrationError,
  MigrationOptions,
} from "./migration/neo4j-to-engram";
export type { LegacyMemoryRow } from "./migration/types";
export {
  mapKind,
  mapBody,
  mapNamespace,
  mapProvenance,
  WEIGHT_TO_SALIENCE,
  parseCreatedAt,
} from "./migration/types";

// ---------------------------------------------------------------------------
// Engram facade — convenience object wrapping all write operations with a
// shared store instance.
// ---------------------------------------------------------------------------
import type { EpisodicStore } from "./store/episodic";
import type {
  EpisodicBody,
  SemanticBody,
  ProceduralBody,
  WriteOpts,
} from "./types";
import { remember as _remember } from "./api/remember";
import { assert as _assert } from "./api/assert";
import { relate as _relate } from "./api/relate";
import { pin as _pin, unpin as _unpin } from "./api/pin";

export interface Engram {
  remember(event: EpisodicBody, opts: WriteOpts): Promise<string>;
  assert(
    fact: SemanticBody,
    confidence: number,
    opts: WriteOpts,
  ): Promise<string>;
  relate(
    source: string,
    edgeType: string,
    target: string,
    opts: WriteOpts,
    properties?: Record<string, unknown>,
  ): Promise<string>;
  pin(rule: ProceduralBody, opts: WriteOpts): Promise<string>;
  unpin(id: string, opts: WriteOpts): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create an Engram instance wrapping a store.
 * This is the recommended high-level API for most callers.
 */
export function createEngram(store: EpisodicStore): Engram {
  return {
    remember: (event, opts) => _remember(store, event, opts),
    assert: (fact, confidence, opts) => _assert(store, fact, confidence, opts),
    relate: (source, edgeType, target, opts, properties) =>
      _relate(store, source, edgeType, target, opts, properties),
    pin: (rule, opts) => _pin(store, rule, opts),
    unpin: (id, opts) => _unpin(store, id, opts),
    close: () => store.close(),
  };
}

// ---------------------------------------------------------------------------
// Phase B: Context Compiler
// ---------------------------------------------------------------------------

// Retrieval
export type {
  RetrievalCandidate,
  RetrievalEngine,
  RetrievalQuery,
  TaskFrame,
} from "./retrieval/types";
export { TemporalRetrievalEngine } from "./retrieval/temporal";
export { LexicalRetrievalEngine } from "./retrieval/lexical";
export type { LexicalSearchFn } from "./retrieval/lexical";
export { fuseAndRank, DEFAULT_WEIGHTS } from "./retrieval/fusion";
export type { FusionWeights } from "./retrieval/fusion";

// Compiler
export { compile, computeBudget } from "./compiler/compile";
export type { CompileOptions } from "./compiler/compile";
export { pack } from "./compiler/packer";
export type {
  TokenBudget,
  PackerInput,
  PackResult,
  TokenUsage,
} from "./compiler/packer";
export { getTokenizer, countTokens } from "./compiler/tokenizer";
export type { Tokenizer } from "./compiler/tokenizer";
export { compressRecord } from "./compiler/compress";
export type { CompressedItem } from "./compiler/compress";
export { buildLayout } from "./compiler/layout";
export type {
  ContextWindow,
  CompileMetadata,
  LayoutInput,
} from "./compiler/layout";
export type { ContextSection, SectionType } from "./compiler/sections";
export { SECTION_POSITIONS, SECTION_STABILITY } from "./compiler/sections";

// Telemetry
export {
  emitCompileTelemetry,
  setCompileTelemetrySink,
  clearCompileTelemetrySinkForTests,
} from "./compiler/telemetry";
export type {
  CompileTelemetryEvent,
  TelemetrySink,
} from "./compiler/telemetry";

// Embedding

// ---------------------------------------------------------------------------
// Phase D: Consolidation & Learning
// ---------------------------------------------------------------------------

// Decay
export {
  effectiveSalience,
  identifyEvictionCandidates,
  computeDecayedSaliences,
  DEFAULT_DECAY_CONFIG,
} from "./decay";
export type { DecayConfig } from "./decay";

// Reinforcement
export { ReinforcementTracker } from "./reinforcement";
export type { ReinforcementStats } from "./reinforcement";

// Consolidation
export {
  distill,
  clusterEvents,
  extractFactFromCluster,
  extractFactHeuristic,
  DEFAULT_DISTILLATION_CONFIG,
} from "./consolidation/distill";
export type {
  DistillationConfig,
  DistillationResult,
  DistillationLlmOptions,
} from "./consolidation/distill";
export { deduplicateSemanticRecords } from "./consolidation/dedupe";
export type { DedupeResult } from "./consolidation/dedupe";
export { detectContradiction, resolveConflict } from "./consolidation/resolve";
export type {
  ConflictRecord,
  ConflictResolution,
} from "./consolidation/resolve";
export { detectPatterns, extractToolSequences } from "./consolidation/patterns";
export type { ActionPattern, PatternConfig } from "./consolidation/patterns";
export { promotePatterns } from "./consolidation/promote";
export type {
  PromotionCandidate,
  PromotionConfig,
} from "./consolidation/promote";

// ---------------------------------------------------------------------------
// Phase C: Event-Sourced Sessions
// ---------------------------------------------------------------------------

export {
  createSession,
  appendEvent,
  getEventsForTurn,
  getEventsUpTo,
  getTurnCount,
  getTurnIds,
  endSession,
} from "./session/event-log";
export { forkSession, getFullHistory } from "./session/fork";
export { analyzeReplay, extractTurnMetrics } from "./session/replay";
export type {
  Session,
  SessionEvent,
  SessionEventType,
  TurnStartData,
  ContextCompiledData,
  ToolCallData,
  ToolResultData,
  MemoryWriteData,
  TurnEndData,
} from "./session/types";
export type { ReplayStep, ReplayResult } from "./session/replay";

// ---------------------------------------------------------------------------
// Phase F: Sync, CRDTs, and Eval
// ---------------------------------------------------------------------------

// CRDTs
export { tick, mergeClock, compareClock, generateTag } from "./sync/crdt";
export type { VectorClock } from "./sync/crdt";
export { ORSet } from "./sync/or-set";
export { PNCounter } from "./sync/pn-counter";
export { mergeRecordSets } from "./sync/merge";
export type { MergeResult, MergeConflict } from "./sync/merge";

// Merkle sync
export {
  buildMerkleTree,
  diffMerkleTrees,
  compareVersions,
  MerkleTree,
} from "./sync/merkle";
export type {
  MerkleNode,
  MerkleChildRef,
  MerkleDiff,
  RecordVersion,
} from "./sync/merkle";
export { recordVersionDigest, toRecordVersion } from "./sync/merge";
export { syncWithPeer } from "./sync/protocol";
export type {
  SyncPeer,
  SyncResult,
  SyncRequest,
  SyncResponse,
} from "./sync/protocol";
export { prioritizeForSync, batchByPriority } from "./sync/priority";

// Eval harness
export { runEvalSuite } from "./eval/harness";
export type { EvalRunResult, EvalSuiteResult } from "./eval/harness";
export { detectRegressions, DEFAULT_THRESHOLDS } from "./eval/metrics";
export type {
  EvalMetrics,
  MetricThresholds,
  MetricRegression,
} from "./eval/metrics";
export { validateTurn } from "./eval/golden-traces";
export type {
  GoldenTrace,
  GoldenTurn,
  TurnValidation,
} from "./eval/golden-traces";
export { generateTextReport, generateJsonReport } from "./eval/report";
export {
  runGoldenSuite,
  buildRagDataset,
  writeRagDataset,
} from "./eval/run-golden";
export type { RagDatasetRecord } from "./eval/run-golden";
export {
  GOLDEN_CORPUS,
  GOLDEN_TRACES,
  GOLDEN_GROUND_TRUTH,
} from "./eval/golden-fixtures";
export { makeGoldenCompileFn, rankCorpus } from "./eval/golden-compile";
export type { CompiledRecord } from "./eval/golden-compile";
