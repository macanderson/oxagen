// The Run page's context window view model, from `get_run_context`
// (ADR-200, #3894): each model request's window as five blocks with their
// bytes and their share of the prompt tokens the vendor reported, the model
// calls recorded with no window, and the steering assembler's manifests.
//
// Every field mirrors the contract. The call's id is `callRef` here because
// an app field ending in `Id` is a public id (INV-11), and a model call's id
// is the engine's or the vendor's, not one of Oxagen's.
import { z } from "zod";

const Count = z.number().int().nonnegative();
const Seq = z.string().regex(/^\d{1,19}$/);

/** The blocks of a window, in the order a request carries them. */
const CONTEXT_BLOCKS = [
  "system",
  "steering",
  "tools",
  "context",
  "conversation",
] as const;
export type ContextBlockKind = (typeof CONTEXT_BLOCKS)[number];

const ContextBlock = z
  .object({
    kind: z.enum(CONTEXT_BLOCKS),
    bytes: Count,
    items: Count,
    /** The block's byte share of `promptTokens`; null when that is null. */
    tokens: Count.nullable(),
  })
  .strict();
export type ContextBlock = z.infer<typeof ContextBlock>;

const ContextWindow = z
  .object({
    /** The frame that recorded the request. */
    seq: Seq,
    /** The frame that recorded the answer; null when none was recorded. */
    responseSeq: Seq.nullable(),
    /** The engine's or the vendor's id for the call. */
    callRef: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    /** The prompt tokens the vendor reported; null when it reported no input. */
    promptTokens: Count.nullable(),
    bytes: Count,
    blocks: z.array(ContextBlock).min(1),
  })
  .strict();
export type ContextWindow = z.infer<typeof ContextWindow>;

const ContextAssembly = z
  .object({
    /** The `steering.manifest` frame. */
    seq: Seq,
    budgetTokens: Count,
    spentTokens: Count,
    included: Count,
    cut: Count,
    textDigest: z.string().nullable(),
  })
  .strict();
export type ContextAssembly = z.infer<typeof ContextAssembly>;

/**
 * Each block's tokens summed over every window the read reached (#5295). A
 * block's tokens are its byte share of each request's vendor total, so the
 * blocks sum to `promptTokens` and the split is an estimate. A block no
 * window carried is null, never zero: a wrapped window has no `context`.
 */
const ContextComposition = z
  .object({
    /** The windows whose call reported its prompt total, which every sum covers. */
    requests: Count,
    /** Windows whose call reported no prompt total; no sum counts their blocks. */
    requestsWithoutTokens: Count,
    /** The prompt tokens of the `requests` windows, summed. */
    promptTokens: Count,
    blocks: z
      .object({
        system: Count.nullable(),
        steering: Count.nullable(),
        tools: Count.nullable(),
        context: Count.nullable(),
        conversation: Count.nullable(),
      })
      .strict(),
    /**
     * The conversation block of the run's first request: the first window
     * that declared tools, else the first window. Null when that request
     * reported no total or carried no conversation.
     */
    initialConversationTokens: Count.nullable(),
  })
  .strict();
export type ContextComposition = z.infer<typeof ContextComposition>;

export const RunContext = z
  .object({
    source: z.enum(["wrapped", "ledger"]),
    windows: z.array(ContextWindow),
    /** Model calls the run recorded with no window. */
    unmeasured: Count,
    assemblies: z.array(ContextAssembly),
    /** False when the read stopped at a cap, so the lists are a prefix. */
    complete: z.boolean(),
    /** The run's prompt composition; null when no window reported a prompt total. */
    composition: ContextComposition.nullable(),
  })
  .strict();
export type RunContext = z.infer<typeof RunContext>;
