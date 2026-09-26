/**
 * `get_run_context`: what one run's model requests carried, block by block,
 * and what the steering assembler put in front of the model (ADR-193;
 * #3894).
 *
 * The Run page draws a model request's window in the frame view (the
 * design's `model.request` and `context.assembled` panels) and in the Context
 * tab's Prompt panel, Prompt window and Retrieval stats. This read answers
 * them from the frames, never from Neo4j:
 *
 * - An in-app assistant run records each window on its
 *   `model.engine_call_started` frame, and the provider's token counts on the
 *   matching `model.engine_call_completed`.
 * - A wrapped session records it on the tacho proxy's `llm_call` frame as the
 *   `oxagen.window` attribute, beside the vendor's usage.
 *
 * A window lists five blocks in request order: `system`, `steering`, `tools`,
 * `context` and `conversation`. A block the recorder could not tell apart is
 * absent and its bytes stay in the block that holds them: the proxy cannot
 * tell a harness's hook context from the conversation, so a wrapped window
 * has no `context` block.
 *
 * Each block's `tokens` is its byte share of `promptTokens`, the prompt total
 * the vendor reported (uncached input, cache reads and cache writes), with
 * largest-remainder rounding. The blocks sum to `promptTokens` by
 * construction, and nothing is tokenized locally. A call that reported no
 * input keeps its bytes and has null tokens.
 *
 * A model call recorded with no window is counted in `unmeasured` and never
 * given a substitute: a run observed through its hooks alone, a recording
 * made before windows were recorded, and a call on an API the proxy does not
 * parse all answer that way.
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";

/** The most windows one answer carries; past it the list is a prefix. */
export const RUN_CONTEXT_WINDOW_MAX = 500;
/** The most assembler manifests one answer carries. */
export const RUN_CONTEXT_ASSEMBLY_MAX = 50;

/** The blocks of a window, in the order a request carries them. */
export const RUN_CONTEXT_BLOCKS = [
  "system",
  "steering",
  "tools",
  "context",
  "conversation",
] as const;

const seqSchema = z.string().regex(/^\d{1,19}$/);
const countSchema = z.number().int().nonnegative();

export const runContextBlockSchema = z
  .object({
    kind: z.enum(RUN_CONTEXT_BLOCKS),
    /** The UTF-8 length of the block's parts, each serialized as JSON. */
    bytes: countSchema,
    /** Messages, tools or text parts, by the block's kind. */
    items: countSchema,
    /** The block's byte share of `promptTokens`; null when that is null. */
    tokens: countSchema.nullable(),
  })
  .strict();

export const runContextWindowSchema = z
  .object({
    /** The frame that recorded the request. */
    seq: seqSchema,
    /**
     * The frame that recorded the answer: the same frame on a wrapped run,
     * the completion on a ledger run, null when no answer was recorded.
     */
    responseSeq: seqSchema.nullable(),
    /** The call's id as the recorder named it; null where it named none. */
    modelCallId: z.string().min(1).max(512).nullable(),
    provider: z.string().min(1).max(128).nullable(),
    /** The model that answered, else the model the host asked for. */
    model: z.string().min(1).max(512).nullable(),
    /** The prompt tokens the vendor reported; null when it reported no input. */
    promptTokens: countSchema.nullable(),
    /** Every byte the window measured. */
    bytes: countSchema,
    blocks: z
      .array(runContextBlockSchema)
      .min(1)
      .max(RUN_CONTEXT_BLOCKS.length),
  })
  .strict();

export const runContextAssemblySchema = z
  .object({
    /** The `steering.manifest` frame the assembler's manifest was sealed into. */
    seq: seqSchema,
    budgetTokens: countSchema,
    spentTokens: countSchema,
    /** The candidates the assembler put in the window. */
    included: countSchema,
    /** The candidates it cut. */
    cut: countSchema,
    /** The digest of the text the model read; null when nothing was included. */
    textDigest: z.string().min(1).max(128).nullable(),
  })
  .strict();

export const runContextGet = registerCapability({
  name: "get_run_context",
  domain: "run",
  description:
    "Read what one run's model requests carried: each request's window as system, steering, tools, context and conversation blocks with their bytes and their share of the prompt tokens the vendor reported, the model calls recorded with no window, and the steering assembler's budget, spend, and included and cut counts.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ runId: runPublicIdSchema }).strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      /** Which store recorded the run. */
      source: z.enum(["wrapped", "ledger"]),
      /** Every measured window on the run's own chain, in frame order. */
      windows: z.array(runContextWindowSchema).max(RUN_CONTEXT_WINDOW_MAX),
      /** Model calls the run recorded with no window. */
      unmeasured: countSchema,
      /** The assembler's manifests, in frame order. */
      assemblies: z
        .array(runContextAssemblySchema)
        .max(RUN_CONTEXT_ASSEMBLY_MAX),
      /** False when the read stopped at a cap, so the lists are a prefix. */
      complete: z.boolean(),
    })
    .strict(),
});

export type RunContextGetOutput = z.output<typeof runContextGet.output>;
export type RunContextWindow = z.output<typeof runContextWindowSchema>;
export type RunContextAssembly = z.output<typeof runContextAssemblySchema>;
