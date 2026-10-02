// selection: ask a model which of a server's tools fits each task in
// tests/selection.jsonl (lane M16; mcp-studio-spec, Try it and tests:
// selection tests).
//
// A selection run spends model tokens, so it runs only when a person asks
// Studio for one. The caller passes the model, built on @oxagen/ai.
export {
  runSelection,
  SELECTION_INSTRUCTIONS,
  SELECTION_RUN_ERROR_CODES,
  selectionReplySchema,
  SelectionRunError,
  selectionTools,
  type SelectionCase,
  type SelectionCaseResult,
  type SelectionCounts,
  type SelectionModel,
  type SelectionOutcome,
  type SelectionReply,
  type SelectionReport,
  type SelectionRequest,
  type SelectionRunErrorCode,
} from "./selection";
