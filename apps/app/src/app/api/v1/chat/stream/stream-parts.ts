/**
 * Concrete shapes for the `fullStream` parts we process. We iterate
 * `result.fullStream as AsyncIterable<unknown>` and type-narrow each part via
 * `partType()` rather than relying on the SDK's `TextStreamPart<ToolSet>`
 * generic, which does not resolve the `tool-result` arm to a concrete
 * narrowable shape when TOOLS is the wide `ToolSet` alias.
 */
export interface TextDeltaPart { type: "text-delta"; text: string }
export interface ReasoningDeltaPart { type: "reasoning-delta"; id: string; text: string }
export interface ReasoningBoundaryPart { type: "reasoning-start" | "reasoning-end"; id: string }
export interface ToolInputStartPart { type: "tool-input-start"; id: string; toolName: string }
export interface ToolInputDeltaPart { type: "tool-input-delta"; id: string; delta: string }
export interface ToolCallPart { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
export interface ToolResultPart { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
export interface ToolErrorPart { type: "tool-error"; toolCallId: string; toolName: string; error: unknown }
export interface FinishPart {
  type: "finish";
  totalUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/** Discriminant accessor for an unknown stream part. */
export function partType(p: unknown): string | undefined {
  return typeof p === "object" && p !== null && "type" in p
    ? String((p as { type: unknown }).type)
    : undefined;
}

/** Narrow an unknown value to a plain record. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Normalize any thrown/streamed error value into a human string. */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Tool execution failed";
}
