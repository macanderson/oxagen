export { distill, clusterEvents, extractFactFromCluster } from "./distill";
export type { DistillationConfig, DistillationResult } from "./distill";
export { DEFAULT_DISTILLATION_CONFIG } from "./distill";

export { deduplicateSemanticRecords } from "./dedup";
export type { DedupResult } from "./dedup";

export { detectContradiction, resolveConflict } from "./resolve";
export type { ConflictRecord, ConflictResolution } from "./resolve";

export { detectPatterns, extractToolSequences } from "./patterns";
export type { ActionPattern, PatternConfig } from "./patterns";

export { promotePatterns } from "./promote";
export type { PromotionCandidate, PromotionConfig } from "./promote";
