/**
 * `list_commands`: the delivery report for one run (Mission Control spec
 * §7.4, §7.6). Every command addressed to the run, newest first, with its
 * §7.4 status, the mode that was requested and the mode that was achieved,
 * and `appliedAtSeq`, the frame that proves an `applied`.
 *
 * The status shown is the recorded one, with one derivation: a command that
 * has not reached a terminal status and whose expiry has passed reads
 * `expired`, so a report is right for a host that stopped polling; a host
 * that holds the row settles it with `applied` or `failed` at the boundary.
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

export const commandReportItemSchema = z
  .object({
    id: z.string().min(1),
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
  })
  .strict();

export type CommandReportItem = z.output<typeof commandReportItemSchema>;

export const tachoCommandList = registerCapability({
  name: "list_commands",
  domain: "control",
  description:
    "The delivery report for one run: every command addressed to it, newest first, with its status, the requested and achieved delivery mode, and the frame an applied command landed on.",
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
      runId: runPublicIdSchema,
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
