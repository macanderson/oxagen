/**
 * `dispatch_command` (Mission Control spec Appendix E; §7.3, §7.4, §7.6):
 * queue a `pause`, `resume`, `cancel`, `steer` or `message` for one run, for
 * every live run of an agent, or for every live run in the workspace, with a
 * §7.3 delivery mode on the commands that carry prompt content.
 *
 * Registered in place of `dispatch_tacho_command` under its Appendix E name
 * (ADR-025, no alias). The file keeps its dotted stem for the file-path
 * realignment phase; the v2 descriptor in `./v2/dispatch-command.ts`
 * composes from this contract.
 *
 * The output is one command id per recipient run. A broadcast that reaches
 * no live run answers an empty list; a broadcast recipient that cannot
 * receive (an `observe`-tier run) is recorded as `failed` with the reason,
 * so the delivery report is complete (§7.6). A direct target that cannot
 * receive is refused instead of queued (§7.3).
 */
import { z } from "zod";
import { STEER_TEXT_MAX, COMMAND_REASON_MAX } from "../tacho/command-limits";
import { registerCapability } from "../registry";
import { tachoDeliveryModeSchema } from "../tacho/schemas";
import { runPublicIdSchema } from "./run.list";

/** The commands an operator can send to a run (spec §7.4 command table). */
export const runCommandSchema = z.enum([
  "pause",
  "resume",
  "cancel",
  "steer",
  "message",
]);
export type RunCommand = z.output<typeof runCommandSchema>;

/** Commands that carry prompt content and so carry a delivery mode. */
export const PROMPT_COMMANDS: ReadonlySet<RunCommand> = new Set([
  "steer",
  "message",
]);

/**
 * §7.6 addressing. `run` is exactly one run; `agent` is every live run of the
 * agent whose key is given (`org_ns.ws_ns.slug`, as `list_runs` reports it);
 * `workspace` is `@agents`, every live run in the caller's workspace.
 */
export const commandTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), id: runPublicIdSchema }).strict(),
  z
    .object({ kind: z.literal("agent"), id: z.string().min(1).max(128) })
    .strict(),
  z.object({ kind: z.literal("workspace"), id: z.string().uuid() }).strict(),
]);
export type CommandTarget = z.output<typeof commandTargetSchema>;

export { STEER_TEXT_MAX, COMMAND_REASON_MAX } from "../tacho/command-limits";

export const commandPayloadSchema = z
  .object({
    /** The steering or message text. Evidence, quoted and cited; never executed by Oxagen. */
    text: z.string().min(1).max(STEER_TEXT_MAX),
    /**
     * §7.3. On a broadcast this is a ceiling: each recipient's connection
     * point resolves the strongest mode it can carry at or below it, and the
     * row records both.
     */
    requestedMode: tachoDeliveryModeSchema.default("next_step"),
  })
  .strict();

/** The input fields, before the cross-field rule; the MCP tool spreads this shape. */
export const dispatchCommandFieldsSchema = z
  .object({
    target: commandTargetSchema,
    command: runCommandSchema,
    /** Required for `steer` and `message`; refused on the others. */
    payload: commandPayloadSchema.optional(),
    /** Read by the model on resume, and shown on the pause banner. */
    reason: z.string().min(1).max(COMMAND_REASON_MAX).optional(),
    /** 10 s to 24 h. A command with no expiry could never reach `expired`. */
    expiresInMs: z
      .number()
      .int()
      .min(10_000)
      .max(86_400_000)
      .default(3_600_000),
  })
  .strict();

export const dispatchCommandInputSchema =
  dispatchCommandFieldsSchema.superRefine((input, ctx) => {
    const carriesPrompt = PROMPT_COMMANDS.has(input.command);
    if (carriesPrompt && input.payload === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: `${input.command} requires payload.text`,
      });
    }
    if (!carriesPrompt && input.payload !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: `${input.command} carries no prompt content; omit payload`,
      });
    }
  });

export const tachoCommandDispatch = registerCapability({
  name: "dispatch_command",
  domain: "control",
  description:
    "Queue a pause, resume, cancel, steer or message command for one run, an agent's live runs, or every live run in the workspace, with a delivery mode on steer and message.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
  // A control command is never refused for lack of governed action units:
  // a lapsed bucket must not leave an agent unstoppable.
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  agent: { requiresApproval: false, riskLevel: "medium", category: "control" },
  input: dispatchCommandInputSchema,
  output: z
    .object({
      /** One `tcm_…` id per recipient run, in the order the rows were written. */
      commandIds: z.array(z.string().min(1)),
    })
    .strict(),
});

export type DispatchCommandInput = z.output<typeof tachoCommandDispatch.input>;
export type DispatchCommandOutput = z.output<
  typeof tachoCommandDispatch.output
>;
