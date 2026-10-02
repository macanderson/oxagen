import { z } from "zod";
import { registerCapability } from "../registry";
import { studioServerNameSchema } from "./tool.studio.draft.save";

/**
 * A selection run for one server folder (mcp-studio-spec, Try it and tests;
 * lane M16). Each line of the folder's tests/selection.jsonl holds a task and
 * the tool that fits it, or null when none does. The handler asks a model on
 * the workspace's route to pick one of the server's tools for each task, and
 * reports each hit and miss.
 *
 * It runs only when a person asks. No schedule, compile check, or webhook
 * calls it, because every task is a billed model call. The handler builds the
 * folder the way list_studio_findings does, so the run offers the tools as
 * Studio shows them, draft edits included. It reads tests/selection.jsonl
 * from the production branch, because Review does not write that file.
 *
 * The run asks a few tasks at once. At its deadline it returns the tasks that
 * finished, marks the rest not_run, and sets stoppedAtDeadline (#5171).
 */

const taskSchema = {
  /** The task's line in tests/selection.jsonl, from 1. */
  line: z.number().int().min(1),
  task: z.string(),
  /** The full name of the tool that fits the task, or null when none does. */
  expected: z.string().nullable(),
};

/**
 * One task's result. A hit or a miss names the tool the model picked, or null
 * when it picked none. A malformed reply, a skipped task, or a task the run
 * did not finish says why instead.
 */
export const studioSelectionCaseSchema = z.union([
  z.object({
    ...taskSchema,
    /** hit: the model picked the expected tool, or none when none fits. miss: it picked anything else. */
    status: z.enum(["hit", "miss"]),
    chosen: z.string().nullable(),
  }),
  z.object({
    ...taskSchema,
    /** malformed: the reply could not be read, or named a tool the server does not offer. skipped: the task expects a tool the server does not offer, so the run did not ask. not_run: the run reached its deadline before the model answered. */
    status: z.enum(["malformed", "skipped", "not_run"]),
    reason: z.string(),
  }),
]);
export type StudioSelectionCase = z.output<typeof studioSelectionCaseSchema>;

export const toolStudioSelectionRun = registerCapability({
  name: "run_studio_selection",
  domain: "tool",
  description:
    "Run a server folder's selection tests: ask the workspace's model to pick one of the server's tools for each task in tests/selection.jsonl, and count the hits and misses. Runs only when asked. Each task is one model call, billed as in-app agent spend, and one run asks at most 50 tasks. A run that reaches its deadline returns the tasks that finished and marks the rest not run.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
    })
    .strict(),
  output: z.object({
    server: z.string(),
    /** "draft" when the run offered the saved draft's tools, "published" when it offered the production folder's. */
    basis: z.enum(["draft", "published"]),
    /** The draft revision the run offered, or null for the production folder. */
    revision: z.number().int().min(1).nullable(),
    /** The model the run asked, or null when it asked nothing. */
    model: z.string().nullable(),
    /** How many tasks came out each way. hits, misses, malformed, skipped, and notRun add up to total. */
    counts: z.object({
      total: z.number().int().min(0),
      hits: z.number().int().min(0),
      misses: z.number().int().min(0),
      malformed: z.number().int().min(0),
      skipped: z.number().int().min(0),
      /** Tasks the run did not finish before its deadline. Defaults to 0, so an output from before #5171 still parses. */
      notRun: z.number().int().min(0).default(0),
    }),
    /** One result per task, in the order of tests/selection.jsonl. */
    cases: z.array(studioSelectionCaseSchema),
    /** True when the run reached its deadline before every task finished. Each task it did not finish is not_run. */
    stoppedAtDeadline: z.boolean().default(false),
  }),
});

export type ToolStudioSelectionRunInput = z.output<typeof toolStudioSelectionRun.input>;
export type ToolStudioSelectionRunOutput = z.output<typeof toolStudioSelectionRun.output>;
