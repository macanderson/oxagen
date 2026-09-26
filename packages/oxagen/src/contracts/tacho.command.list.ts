/**
 * `list_commands`: the delivery report for one run (Mission Control spec
 * §7.4, §7.6). Every command addressed to the run, newest first, with its
 * §7.4 status, the mode that was requested and the mode that was achieved,
 * and `appliedAtSeq`, the frame that proves an `applied`.
 *
 * A read names one run by `runId`, or a set of commands by `commandIds`: the
 * ids `dispatch_command` returned for a broadcast, so one report covers every
 * run the broadcast reached (#2953). Each row names its run, its issuer and,
 * for a steer or a message, its text.
 *
 * The status shown is the recorded one, with one derivation: a `queued`
 * command whose expiry has passed reads `expired`, what the host's next poll
 * writes, so a report is right for a host that stopped polling. A command
 * the host holds reads as recorded until the host settles it with `applied`,
 * `expired` or `failed` at the boundary; `expiresAt` is there for the
 * interface to show it as past expiry and awaiting the host.
 * A console read is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  tachoCommandSchema,
  tachoCommandStatusSchema,
  tachoDeliveryModeSchema,
} from "../tacho/schemas";
import { runPublicIdSchema } from "./run.list";

/** The most command ids one read takes: a broadcast's recipients. */
export const LIST_COMMANDS_IDS_MAX = 100;

export const commandReportItemSchema = z
  .object({
    id: z.string().min(1),
    /** The run the command is addressed to: the row's `target_id`. */
    runId: runPublicIdSchema,
    /** The wire vocabulary: what the row holds, including a kind an earlier contract queued. */
    command: tachoCommandSchema,
    status: tachoCommandStatusSchema,
    /** Null for a command that carries no prompt content. */
    requestedMode: tachoDeliveryModeSchema.nullable(),
    /** The mode achieved, at or below the requested one; null until resolved. */
    deliveryMode: tachoDeliveryModeSchema.nullable(),
    degradedReason: z.string().nullable(),
    reason: z.string().nullable(),
    /** RFC 3339. */
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    sentAt: z.string().datetime().nullable(),
    acknowledgedAt: z.string().datetime().nullable(),
    appliedAt: z.string().datetime().nullable(),
    /** The frame sequence the effect landed on; null until `applied`. */
    appliedAtSeq: z.number().int().nonnegative().nullable(),
    /** The connection point's detail on `failed`, or the supersession note on `cancelled`. */
    detail: z.string().nullable(),
    /** The person who issued the command; null when the row names none. */
    issuedBy: z
      .object({
        /** The person's public id (`usr_…`). */
        id: z.string().min(1),
        /** Null when the user record holds no name. */
        name: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /**
     * The text a `steer` or `message` carried (`payload.text`). Null on every
     * other command.
     */
    text: z.string().nullable(),
  })
  .strict();

export type CommandReportItem = z.output<typeof commandReportItemSchema>;

export const tachoCommandList = registerCapability({
  name: "list_commands",
  domain: "control",
  description:
    "The delivery report for one run, or for the commands one broadcast queued: every command, newest first, with its run, its issuer, its text, its status, the requested and achieved delivery mode, and the frame an applied command landed on.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  input: z
    .object({
      /**
       * The run whose commands to list. Send this or `commandIds`, never
       * both and never neither: the handler refuses either as
       * `invalid_input` (`run_or_commands`). The object stays unrefined so
       * the MCP tool can spread its shape.
       */
      runId: runPublicIdSchema.optional(),
      /**
       * The commands to list (`tcm_…`), such as the ids a broadcast
       * `dispatch_command` returned. An id outside the workspace, or one that
       * names no command, is left out rather than refused.
       */
      commandIds: z
        .array(z.string().min(1))
        .min(1)
        .max(LIST_COMMANDS_IDS_MAX)
        .optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  output: z
    .object({
      commands: z.array(commandReportItemSchema),
    })
    .strict(),
});

export type ListCommandsInput = z.output<typeof tachoCommandList.input>;
export type ListCommandsOutput = z.output<typeof tachoCommandList.output>;
