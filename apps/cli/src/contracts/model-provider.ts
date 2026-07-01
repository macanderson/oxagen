/**
 * Model-runtime contract surface (pipeline Group 1 — already shipped).
 *
 * Re-exports the real, already-implemented types from `runtime/index.ts` as the
 * canonical Group 1 contract, rather than re-declaring a second copy that could
 * drift. The original `contracts/model-provider.ts` stub predates the shipped
 * runtime and disagrees with it in several places — most notably
 * `CompletionRequest` (`{system,prompt,maxTokens,timeoutMs}` in the stub vs the
 * shipped `{messages,maxOutputTokens,temperature,effort,signal}`) and
 * `CompletionResult` (`{text,tokensIn,tokensOut,model,ms}` in the stub vs the
 * shipped `{text,usage,model,kind,costUsd}`). Per the Group 7 brief — "if the
 * JSON and the type disagree, fix the type to match the JSON, then flag it" —
 * this file follows the shipped shapes. See the PR description's
 * "Reconciliation notes" for the full list of disagreements.
 */
export type {
  CapabilityRow,
  CompletionMessage,
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  DeviceProfile,
  ModelCapabilities,
  ModelKind,
  ModelProvider,
  Quantization,
  ReasoningEffort,
} from "../runtime/index.js";
