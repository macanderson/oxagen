import { z } from "zod";
import { registerCapability } from "../registry";

export const agentExecutionRecord = registerCapability({
  name: "agent.execution.record",
  description: "Record a complete agent execution with steps and tool calls for lineage tracking and analytics",

  input: z.object({
    agentId: z.string().uuid(),
    agentVersionId: z.string().uuid(),
    originType: z.enum(["chat", "event_trigger", "scheduled_job", "mcp_request", "workflow_run"]),
    originId: z.string().uuid(),
    status: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
    inputPayload: z.record(z.unknown()),
    outputPayload: z.record(z.unknown()).optional(),
    failureReason: z.string().optional(),
    startedAt: z.date().optional(),
    completedAt: z.date().optional(),
    latencyMs: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    estimatedCostUsd: z.number().optional(),
    steps: z
      .array(
        z.object({
          stepNumber: z.number(),
          stepType: z.enum(["tool_call", "decision", "retry", "wait"]),
          status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
          inputPayload: z.record(z.unknown()),
          outputPayload: z.record(z.unknown()).optional(),
          failureReason: z.string().optional(),
          latencyMs: z.number().optional(),
          inputTokens: z.number().optional(),
          outputTokens: z.number().optional(),
          toolCalls: z
            .array(
              z.object({
                toolName: z.string(),
                toolType: z.enum(["mcp", "capability", "builtin"]),
                requestPayload: z.record(z.unknown()),
                responsePayload: z.record(z.unknown()).optional(),
                status: z.enum(["pending", "running", "completed", "failed"]),
                latencyMs: z.number().optional(),
                inputTokens: z.number().optional(),
                outputTokens: z.number().optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
  }),

  output: z.object({
    executionId: z.string().uuid(),
    status: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
    createdAt: z.date(),
  }),

  surfaces: ["api", "mcp"],
});
