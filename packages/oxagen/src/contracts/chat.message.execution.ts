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
