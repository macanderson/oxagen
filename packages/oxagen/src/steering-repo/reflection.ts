// reflection.ts: `reflection/v1`, the memory an agent writes at the end of a
// run (steering-repo-spec, Memory and reflection). It grades the work and the
// tools the agent was given, and carries the lessons worth promoting.
//
// A reflection stays in Oxagen. Its lessons reach a repository only through a
// memory PR, and its tool grades and feedback never steer anything: they go
// to the server's owner and to MCP Studio.
import { z } from "zod";
import { runOutcomeSchema } from "../contracts/run.list";
import {
  frameRefSchema,
  lineageSchema,
  repoRefSchema,
  runIdSchema,
  toolRefSchema,
  toolTargetSchema,
} from "./common";
import { recordKindSchema } from "./record";

/** A grade from 1, poor, to 5, excellent. */
export const gradeSchema = z.number().int().min(1).max(5);

/** How the run ended, in the run record's words. A reflection is written after the work, so never `running`. */
export const reflectionOutcomeSchema = runOutcomeSchema.exclude(["running"]);

/** One lesson the curator may promote as a memory, a rule, or a fact. */
export const lessonSchema = z
  .object({
    statement: z.string().min(1).max(2000),
    kind: recordKindSchema.describe(
      "What the lesson would be as a record. Most are memory.",
    ),
    repos: z.array(repoRefSchema).min(1).optional(),
    applies_to: z.array(z.string().min(1)).min(1).optional(),
    tools: z.array(toolTargetSchema).min(1).optional(),
    evidence: z
      .array(frameRefSchema)
      .min(1)
      .describe("The frames that taught the lesson."),
  })
  .strict();

export const reflectionSchema = z
  .object({
    schema: z.literal("reflection/v1"),
    run: runIdSchema,
    agent: lineageSchema.describe("The agent's name, as agents/<name>.toml gives it."),
    outcome: reflectionOutcomeSchema,
    summary: z.string().min(1).max(2000),
    grades: z
      .object({
        work: gradeSchema,
        tools: z
          .record(toolRefSchema, gradeSchema)
          .describe("A grade per tool the agent was given, pinned to its version where known."),
      })
      .strict(),
    lessons: z.array(lessonSchema).max(50),
    tool_feedback: z
      .array(
        z
          .object({
            tool: toolRefSchema,
            problem: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .optional()
      .describe("What went wrong with a tool. MCP Studio shows it beside the tool."),
  })
  .strict();
export type Reflection = z.output<typeof reflectionSchema>;
