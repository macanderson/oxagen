import { z } from "zod";
import { registerCapability } from "../registry";

const executionStepSchema = z.object({
  stepNumber: z.number().int().nonnegative(),
  stepType: z.string(),
  status: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
  inputPayload: z.unknown(),
  outputPayload: z.unknown().optional(),
  failureReason: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  toolCalls: z
    .array(
      z.object({
        toolName: z.string(),
        toolType: z.string(),
        requestPayload: z.unknown(),
        responsePayload: z.unknown().optional(),
        status: z.enum(["pending", "running", "completed", "failed"]),
        latencyMs: z.number().int().nonnegative().optional(),
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
});

export const chatMessageExecution = registerCapability({
  name: "get_message_execution",
  domain: "chat",
  description:
    "Record an agent execution that originated from a chat message; atomically links the execution to the message for observability and UI streaming",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  // Bookkeeping, never a metered turn. This writes the execution row and the
  // lineage projection AFTER the work it describes has already happened, so
  // it spends no model tokens of its own.
  //
  // It is not a theoretical tag. The in-app agent's turn runs under
  // `runOutsideGovernedAction` so that each tool call the model asks for is
  // its own top-level governed action (ADR-053 §1) — and the turn's own
  // `recordTurnExecution` invoke (assistant-turn.ts) sits inside that same
  // exited frame, so without this it was top-level too. That charged a
  // governed action for the platform's own audit write on every successful
  // reply, and, worse, put the credit and budget gates in front of it: an org
  // at zero balance had the gate refuse the recording, which is the one path
  // that makes `list_executions` and `get_execution_trace` answer "nothing
  // happened" for a turn that did happen. The audit trail must not be the
  // thing that fails when the balance does.
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "allow",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    messageId: z.string().uuid(),
    agentId: z.string().uuid(),
    agentVersionId: z.string().uuid(),
    originType: z.literal("chat"),
    originId: z.string().uuid(),
    status: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
    inputPayload: z.unknown(),
    outputPayload: z.unknown().optional(),
    failureReason: z.string().optional(),
    startedAt: z.coerce.date().optional(),
    completedAt: z.coerce.date().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    updateMessageMetadata: z.boolean().default(true),
    steps: z.array(executionStepSchema).optional(),
  }),
  output: z.object({
    executionId: z.string().uuid(),
    status: z.string(),
    createdAt: z.coerce.date(),
  }),
});

export type ChatMessageExecutionInput = z.output<
  typeof chatMessageExecution.input
>;
export type ChatMessageExecutionOutput = z.output<
  typeof chatMessageExecution.output
>;
