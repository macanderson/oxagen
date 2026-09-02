import { z } from "zod";
import { CAPABILITY_SLUG_PATTERN, KEBAB_SLUG_PATTERN } from "./slugs";

/**
 * The points in a turn where an agent may hand control to a capability, in the
 * order the runtime reaches them. `before_*` events can still change what
 * happens next; `after_*` events observe a step that already ran.
 */
export const lifecycleEventSchema = z.enum([
  "before_turn",
  "before_intelligence",
  "before_model_call",
  "after_model_call",
  "before_tool_call",
  "after_tool_call",
  "after_intelligence",
  "before_finalize",
  "after_turn",
]);

export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const pointerInputSchema = z
  .object({
    from: z.string().regex(/^\/(?:[^/~]|~[01])*(?:\/(?:[^/~]|~[01])*)*$/),
    required: z.boolean().optional(),
  })
  .strict();

const literalInputSchema = z
  .object({
    literal: jsonValueSchema,
  })
  .strict();

/**
 * How one input field of a lifecycle capability gets its value: either read out
 * of the event envelope by JSON Pointer (`from`), or baked into the artifact
 * (`literal`). Both members are `.strict()`, so supplying both is rejected.
 */
export const lifecycleInputBindingSchema = z.union([
  pointerInputSchema,
  literalInputSchema,
]);

/**
 * One capability call bound to one lifecycle event. The cross-field rules below
 * exist so an artifact cannot describe a call the runtime would have to refuse
 * at dispatch time: a prompt patch after the prompt is already sent, a
 * `when` filter on an event that has no outcome yet, a retry with no attempt
 * budget, or a required call that is also allowed to fail silently.
 */
export const lifecycleInvocationSchema = z
  .object({
    id: z.string().regex(KEBAB_SLUG_PATTERN),
    event: lifecycleEventSchema,
    capability: z.string().regex(CAPABILITY_SLUG_PATTERN),
    required: z.boolean(),
    apply_as: z.enum(["opaque", "prompt_patch", "decision"]).optional(),
    timeout_ms: z.number().int().min(1).max(300_000),
    on_error: z.enum(["block", "retry", "continue"]),
    max_attempts: z.number().int().min(2).max(10).optional(),
    when: z.enum(["success", "failure", "always"]).optional(),
    input: z.record(z.string(), lifecycleInputBindingSchema).optional(),
    output_schema: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.replaceAll("\\", "/").split("/").includes(".."),
        "must be a contained relative path",
      )
      .optional(),
  })
  .strict()
  .superRefine((invocation, context) => {
    if (
      invocation.apply_as === "prompt_patch" &&
      invocation.event !== "before_intelligence" &&
      invocation.event !== "before_model_call"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apply_as"],
        message:
          "prompt patches are only legal before intelligence or a model call",
      });
    }
    if (
      invocation.when !== undefined &&
      invocation.event !== "before_finalize" &&
      invocation.event !== "after_turn"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["when"],
        message: "when is only legal for finalization and terminal events",
      });
    }
    if (invocation.on_error === "continue" && invocation.required) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["on_error"],
        message: "continue is only legal for optional invocations",
      });
    }
    if (
      invocation.on_error === "retry" &&
      invocation.max_attempts === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_attempts"],
        message: "retry requires max_attempts",
      });
    }
    if (
      invocation.on_error !== "retry" &&
      invocation.max_attempts !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_attempts"],
        message: "max_attempts is only legal with retry",
      });
    }
  });

/**
 * The full set of lifecycle calls an agent declares. `delivery` is `buffered`
 * only: every invocation runs to completion (or fails) before the turn moves
 * on, so a caller never sees a half-applied patch.
 */
export const agentDriverSchema = z
  .object({
    delivery: z.literal("buffered"),
    invocations: z.array(lifecycleInvocationSchema),
  })
  .strict()
  .superRefine((driver, context) => {
    const ids = new Set<string>();
    for (const [index, invocation] of driver.invocations.entries()) {
      if (ids.has(invocation.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["invocations", index, "id"],
          message: "invocation ids must be unique",
        });
      }
      ids.add(invocation.id);
    }
  });

const contentOperationSchema = z
  .object({
    op: z.enum([
      "prepend_system_context",
      "append_system_context",
      "prepend_user_context",
      "append_user_context",
    ]),
    content: z.string().min(1).max(32_768),
  })
  .strict();

const pathOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("redact_input_path"),
      path: z.string().startsWith("/"),
    })
    .strict(),
  z
    .object({
      op: z.literal("replace_input_path"),
      path: z.string().startsWith("/"),
      value: jsonValueSchema,
    })
    .strict(),
]);

const metadataOperationSchema = z
  .object({
    op: z.literal("add_metadata"),
    key: z.string().min(1).max(128),
    value: jsonValueSchema,
  })
  .strict();

const rejectOperationSchema = z
  .object({
    op: z.literal("reject_turn"),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_048),
  })
  .strict();

/**
 * One edit a lifecycle capability may make to a turn before the model sees it.
 * The set is deliberately closed: text can be added around the prompt, an input
 * path can be redacted or replaced, metadata can be attached, or the turn can
 * be rejected outright. Nothing here can rewrite the agent's instructions.
 */
export const promptPatchOperationSchema = z.union([
  contentOperationSchema,
  pathOperationSchema,
  metadataOperationSchema,
  rejectOperationSchema,
]);

/**
 * A capability's returned patch, capped at 64 operations so one lifecycle call
 * cannot grow a prompt without bound.
 */
export const promptPatchSchema = z
  .object({
    operations: z.array(promptPatchOperationSchema).max(64),
  })
  .strict();

export type LifecycleInvocation = z.infer<typeof lifecycleInvocationSchema>;
export type AgentDriver = z.infer<typeof agentDriverSchema>;
export type PromptPatch = z.infer<typeof promptPatchSchema>;

/**
 * What a lifecycle capability is handed when it runs. This is also the document
 * an invocation's `from` pointers read against, so the field names here are a
 * public contract: renaming one breaks every artifact that points at it.
 *
 * The optional blocks are populated per event — `prompt` before intelligence,
 * `modelCall` around a model call, `toolCall` around a tool call, and
 * `candidateOutput` / `error` at finalization.
 */
export interface LifecycleEventEnvelope {
  schemaVersion: 1;
  event: LifecycleEvent;
  invocationId: string;
  idempotencyKey: string;
  turn: {
    id: string;
    input: unknown;
    metadata: Record<string, unknown>;
    status: "running" | "succeeded" | "rejected" | "failed" | "cancelled";
  };
  agent: { name: string; artifactHash: string };
  principal: {
    orgId: string;
    workspaceId: string;
    kind: "user" | "api_key" | "service" | "agent";
    principalId: string;
    delegatedByPrincipalId?: string;
    delegationGrantId?: string;
  };
  prompt?: { effectiveHash: string };
  modelCall?: { index: number; modelId: string };
  toolCall?: {
    id: string;
    name: string;
    input: unknown;
    outcome?: "success" | "failure" | "denied";
  };
  candidateOutput?: unknown;
  error?: { code: string; message: string };
}

/**
 * The audit record one invocation leaves behind. Inputs, outputs, and the
 * prompt before and after a patch are recorded as hashes rather than values so
 * a receipt stays durable and citable without carrying tenant content.
 */
export interface LifecycleInvocationReceipt {
  schemaVersion: 1;
  turnId: string;
  invocationId: string;
  event: LifecycleEvent;
  capability: string;
  idempotencyKey: string;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: "succeeded" | "continued" | "blocked" | "cancelled";
  inputHash: string;
  outputHash?: string;
  promptBeforeHash?: string;
  patchHash?: string;
  promptAfterHash?: string;
  errorCode?: string;
}
