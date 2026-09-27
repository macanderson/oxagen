import { z } from "zod";
import { registerCapability } from "../registry";
import { gradeSchema, reflectionOutcomeSchema } from "../steering-repo/reflection";
import {
  lessonInputSchema,
  memoryCaptureAckSchema,
} from "./agent.memory.lesson.remember";

/**
 * record_reflection: the memory an agent writes at the end of a run
 * (steering-repo-spec, Memory and reflection; ADR-206).
 *
 * Like `remember_lesson`, the call writes nothing. When the run seals,
 * `run.reflect` reads this call's frame, checks it against this contract, and
 * stores a `reflection/v1` with the agent and run Oxagen recorded. Each lesson
 * becomes a `memory/v1` the curator may propose. The tool grades and tool
 * feedback go to each tool server's owner and never steer.
 *
 * Tool names are the ones the agent saw, such as `mcp__billing__create_refund`
 * in Claude Code or `billing__create_refund` elsewhere. Oxagen maps each to
 * `<server>__<tool>` and drops a built-in tool, which has no server owner.
 */
const toolSeenSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("A tool name as you saw it, such as mcp__billing__create_refund.");

export const reflectionInputSchema = z
  .object({
    outcome: reflectionOutcomeSchema.describe("How the run ended."),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("What the run did, in one paragraph."),
    grades: z
      .object({
        work: gradeSchema.describe("Your work on the task, from 1 to 5."),
        tools: z
          .record(toolSeenSchema, gradeSchema)
          .default({})
          .describe("A grade from 1 to 5 for each tool you used."),
      })
      .strict(),
    lessons: z
      .array(lessonInputSchema)
      .max(50)
      .default([])
      .describe("Lessons worth keeping for the next run."),
    tool_feedback: z
      .array(
        z
          .object({
            tool: toolSeenSchema,
            problem: z
              .string()
              .min(1)
              .max(2000)
              .describe("What was wrong with the tool or its description."),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();
export type ReflectionInput = z.output<typeof reflectionInputSchema>;

export const agentMemoryReflectionRecord = registerCapability({
  name: "record_reflection",
  domain: "agent",
  description:
    "Reflect on the current run: its outcome, a summary, a grade for the work and each tool, and the lessons worth keeping. Oxagen stores it when the run ends.",
  mode: "sync",
  surfaces: ["mcp"],
  layers: ["schema", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: reflectionInputSchema,
  output: memoryCaptureAckSchema,
});

export type AgentMemoryReflectionRecordInput = z.input<
  typeof agentMemoryReflectionRecord.input
>;
export type AgentMemoryReflectionRecordOutput = z.output<
  typeof agentMemoryReflectionRecord.output
>;
