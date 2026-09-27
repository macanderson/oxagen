import { z } from "zod";
import { registerCapability } from "../registry";
import { repoRefSchema, toolTargetSchema } from "../steering-repo/common";
import { recordKindSchema } from "../steering-repo/record";

/**
 * remember_lesson: an agent keeps one lesson from the run it is in
 * (steering-repo-spec, Memory and reflection; ADR-206).
 *
 * The call writes nothing. Oxagen takes the agent and the run from the run it
 * watched, never from tool input, so the lesson is stored from the run's own
 * record: when the run seals, `run.reflect` reads this call's frame, checks the
 * input against this contract again, and writes a `memory/v1` with capture
 * `remember`. A call Oxagen denied or that failed is never stored. That is why
 * the contract says `mutates: false`, and why the local gateway may list it.
 *
 * A caller with no watched run behind it, such as a script holding an API key,
 * gets an error: there is no run to attribute the lesson to.
 *
 * `evidence` is a list of frame numbers in the current run. An agent that does
 * not know them leaves it empty, and Oxagen cites the frame of this call.
 */
export const lessonInputSchema = z
  .object({
    statement: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe(
        "The lesson in one or two sentences, written as advice for the next run.",
      ),
    kind: recordKindSchema
      .default("memory")
      .describe(
        "What the lesson would be as a steering record. Most are memory.",
      ),
    repos: z
      .array(repoRefSchema)
      .min(1)
      .max(20)
      .optional()
      .describe(
        "The repositories the lesson is about, as <host>/<owner>/<name> in lowercase.",
      ),
    applies_to: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(20)
      .optional()
      .describe("Path globs the lesson applies to, such as src/billing/**."),
    tools: z
      .array(toolTargetSchema)
      .min(1)
      .max(20)
      .optional()
      .describe("Tools the lesson is about, as <server>__<tool>."),
    evidence: z
      .array(z.number().int().min(0))
      .max(20)
      .default([])
      .describe(
        "Frame numbers in this run that taught the lesson. Leave empty if you do not know them.",
      ),
  })
  .strict();
export type LessonInput = z.output<typeof lessonInputSchema>;

/** What both memory capture calls answer. The lesson is stored later, from the run's record. */
export const memoryCaptureAckSchema = z
  .object({
    status: z.literal("noted"),
    message: z.string(),
  })
  .strict();
export type MemoryCaptureAck = z.output<typeof memoryCaptureAckSchema>;

export const agentMemoryLessonRemember = registerCapability({
  name: "remember_lesson",
  domain: "agent",
  description:
    "Keep one lesson from the current run. Oxagen stores it when the run ends, with the agent and run it recorded, and a curator may propose it as a steering record.",
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
  input: lessonInputSchema,
  output: memoryCaptureAckSchema,
});

export type AgentMemoryLessonRememberInput = z.input<
  typeof agentMemoryLessonRemember.input
>;
export type AgentMemoryLessonRememberOutput = z.output<
  typeof agentMemoryLessonRemember.output
>;
