// Speculative tool execution (ADR-030): prefetch the model's likely next
// reads while it thinks, behind a hard-coded read-only allowlist.
export {
  wrapToolsWithSpeculation,
  speculationKey,
  SPECULATABLE_TOOLS,
  type SpeculationStats,
  type SpeculativeToolsOptions,
} from "./layer";
export {
  heuristicPredictor,
  MAX_PREDICTIONS_PER_OBSERVATION,
  type SpeculationPredictor,
  type PredictedCall,
  type ToolObservation,
} from "./predictor";
