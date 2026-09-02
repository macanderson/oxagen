import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.compose — plan and execute a chain of capabilities to accomplish a goal.
 *
 * An LLM planner reads the agent-surface capability catalog (enriched with the
 * produces/consumes/chainHints metadata from capability-meta.ts), the workspace
 * system prompt, and the workspace's enabled skills, then drafts an ordered
 * plan. The executor threads each step's OUTPUT into dependent steps' INPUTS via
 * `$steps.<id>.<dotpath>` bindings, runs every step through the same invoke()
 * kernel path (so IAM / billing / entitlement gates all apply), and finally
 * synthesizes a natural-language summary for the user.
 *
 * Destructive or approval-required capabilities are PLANNED but never
 * auto-executed — they come back as `skipped` so a human stays in the loop.
 */

const composeStepPlan = z.object({
  id: z.string().describe("Unique step id within the plan (e.g. 'step1')"),
  capability: z.string().describe("The capability name this step invokes"),
  rationale: z.string().describe("Why this step is part of the plan"),
  inputJson: z
    .string()
    .describe(
      "JSON object for the capability input. May reference a prior step's output via " +
        "$steps.<id>.<dotpath> (e.g. $steps.step1.nodeId), resolved by the executor.",
    ),
  dependsOn: z
    .array(z.string())
    .default([])
    .describe(
      "Ids of steps that must complete successfully before this one runs",
    ),
});

const composeStepResult = z.object({
  id: z.string(),
  capability: z.string(),
  rationale: z.string(),
  status: z.enum(["success", "error", "skipped"]),
  /** The resolved input actually passed to invoke(); null when never executed. */
  input: z.record(z.string(), z.unknown()).nullable(),
  /** The capability output on success. */
  output: z.unknown().optional(),
  /** Failure / skip reason. */
  error: z.string().optional(),
  durationMs: z.number(),
});

export const agentCompose = registerCapability({
  name: "run_capability_chain",
  domain: "agent",
  description:
    "Plan and execute a chain of capabilities to accomplish a goal. An LLM planner reads the " +
    "capability catalog (with produces/consumes chain hints), the workspace prompt, and the " +
    "enabled skills to draft an ordered plan; the executor threads each step's output into " +
    "dependent steps' inputs through the invoke() kernel, then synthesizes a natural-language " +
    "summary. Destructive or approval-required capabilities are planned but never auto-executed.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  agent: { requiresApproval: false, riskLevel: "medium", category: "agent" },
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Compose yields a written summary that can seed a document; it doesn't itself
  // produce a record id. Chain metadata kept minimal — it's a meta-capability.
  produces: ["document.text"],
  consumes: [],
  chainHints: ["generate_document"],
  render: { componentId: "capability-chain-card" },
  input: z.object({
    goal: z.string().min(1).max(2000).describe("What to accomplish"),
    maxSteps: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(6)
      .describe("Maximum number of steps the planner may produce"),
    autoExecute: z
      .boolean()
      .default(true)
      .describe("When false, returns the plan WITHOUT executing it (dry run)"),
    context: z
      .string()
      .max(4000)
      .optional()
      .describe("Extra context or constraints for the planner"),
  }),
  output: z.object({
    goal: z.string(),
    plan: z.array(composeStepPlan),
    steps: z.array(composeStepResult),
    summary: z.string(),
    executed: z.boolean(),
  }),
});

export type AgentComposeInput = z.output<typeof agentCompose.input>;
export type AgentComposeOutput = z.output<typeof agentCompose.output>;
export type ComposeStepPlan = z.output<typeof composeStepPlan>;
export type ComposeStepResult = z.output<typeof composeStepResult>;
