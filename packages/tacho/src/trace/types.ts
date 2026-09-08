/**
 * The `contextgraph-trace` journal vocabulary, mirrored member for member from
 * `contextgraph-trace/src/event.rs` at the commit pinned in
 * `fixtures/contextgraph-trace/manifest.json`. Gate on `TRACE_FORMAT`, not on
 * a crate version: the journal wire format may change in any 0.x release.
 */
import { z } from "zod";
import { isProtocolTimestamp } from "../timestamp";

export const TRACE_FORMAT = "contextgraph-trace/0.1-sketch" as const;

export const frameIdSchema = z
  .object({
    provider_id: z.string(),
    frame_id: z.string(),
    content_digest: z.string().optional(),
  })
  .strict();
export type FrameId = z.infer<typeof frameIdSchema>;

export const representationSchema = z.enum(["full", "compact", "reference"]);

export const renderedFrameSchema = z
  .object({
    frame: frameIdSchema,
    representation: representationSchema.default("full"),
    token_cost: z.number().int().min(0),
    citation_label: z.string().optional(),
  })
  .strict();
export type RenderedFrame = z.infer<typeof renderedFrameSchema>;

export const verdictSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid") }).strict(),
  z
    .object({
      status: z.literal("stale"),
      replacement_digest: z.string().optional(),
    })
    .strict(),
  z.object({ status: z.literal("gone") }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
export type Verdict = z.infer<typeof verdictSchema>;

const envelope = {
  seq: z.number().int().min(0),
  at: z.string(),
  session: z.string(),
  turn: z.number().int().min(0).optional(),
};

export const traceEventSchema = z.discriminatedUnion("event", [
  z
    .object({
      ...envelope,
      event: z.literal("session_start"),
      agent: z.string(),
      harness: z.string(),
      model: z.string().optional(),
      trace_format: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("session_end"),
      outcome: z.enum(["completed", "aborted"]),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("resume"),
      last_seq_seen: z.number().int().min(0),
    })
    .strict(),
  z.object({ ...envelope, event: z.literal("turn_start") }).strict(),
  z.object({ ...envelope, event: z.literal("turn_end") }).strict(),
  z
    .object({
      ...envelope,
      event: z.literal("prompt_assembled"),
      budget_tokens: z.number().int().min(0),
      declared_total_tokens: z.number().int().min(0),
      composition_digest: z.string().optional(),
      frames: z.array(renderedFrameSchema),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("model_response"),
      tool_calls: z.array(z.string()).default([]),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("tool_call"),
      call_id: z.string(),
      tool: z.string(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("tool_result"),
      call_id: z.string(),
      status: z.enum(["ok", "error", "rejected"]),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("verify_observed"),
      frame: frameIdSchema,
      verdict: verdictSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("side_effect"),
      effect_id: z.string(),
      kind: z.string(),
      call_id: z.string().optional(),
    })
    .strict(),
]);

export type TraceEvent = z.infer<typeof traceEventSchema>;
export type TraceEventKind = TraceEvent["event"];

export function isTraceTimestamp(value: string): boolean {
  return isProtocolTimestamp(value);
}
