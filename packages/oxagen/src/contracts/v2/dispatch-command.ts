import { z } from "zod";
import { defineTool } from "./_define";
import { tachoCommandDispatch } from "../tacho.command.dispatch";
import { tachoCommandSchema } from "../../tacho/schemas";

/**
 * The closed command-status vocabulary of §7.4, shared by commands and
 * messages so one delivery report reads the same whatever was sent. Declared
 * fresh because no absorbed contract has it: v1's `tachoCommandOutcomeSchema`
 * is `pending | delivered | applied | expired | failed`, which collapses the
 * two distinctions the spec says must survive.
 *
 * - `delivered` merges `sent`, `received` and `acknowledged`. §7.4: "`applied`
 *   is the difference between *the harness has it* and *the model saw it*" —
 *   and answering that is the promise §7.6 makes about every message.
 * - `pending` merges `draft` and `queued`, hiding whether a command ever left
 *   an interface.
 * - `cancelled` had nowhere to go at all, so "the operator changed their mind"
 *   and "the run never reached a boundary" both read as `expired`. §7.4 calls
 *   that the difference between an operator's mistake and a fleet problem.
 *
 * Appendix A.6 stores exactly these nine on `control.commands.status`. The
 * spec is stricter than the code, so the spec wins (carry rule F).
 *
 * Exported for `fetch_commands`, which acknowledges against the same words.
 */
export const commandStatusSchema = z.enum([
  "draft",
  "queued",
  "sent",
  "received",
  "acknowledged",
  "applied",
  "cancelled",
  "expired",
  "failed",
]);

/**
 * §7.3's delivery modes. Also new: v1 queued a command with no way to say which
 * model request it should ride. The mode does not choose *where* a steer lands
 * — steering is prompt content, so it always lands on a `model.request` — it
 * chooses which request, and whether Oxagen cuts the current step short to
 * reach one sooner.
 */
export const deliveryModeSchema = z.enum([
  /** Default. The current step finishes; the steer rides the next request. Costs nothing. */
  "next_step",
  /** In-flight response stopped and billed, pending tool call abandoned. For harm in progress. */
  "interrupt",
  /** Waits for `turn_end`. For a change of priority that should not land mid-plan. */
  "turn_boundary",
]);

/**
 * Appendix E: `dispatch_command` — "pause, resume, steer, cancel, revoke".
 * Absorbs `dispatch_tacho_command`.
 *
 * Two changes where the spec is stricter than the code it absorbs.
 *
 * 1. **`steer` exists and `kill` does not.** v1's command enum is `pause,
 *    resume, cancel, message, revoke, refresh_bundle, kill` — it has no
 *    `steer`, which is the single most important command in §7.3 and §7.4 and
 *    the first word in this tool's `Does` column. It is added. `kill` is
 *    removed: §7.4 folds process termination into `cancel` ("the collector
 *    sends SIGTERM where it owns the process"), and Appendix A.6's command
 *    vocabulary has `kill_switch_on`/`kill_switch_off` instead — those are
 *    §6.11 kill switches at tool, connection, agent, workspace or class level
 *    and belong to `set_kill_switch`, not to a per-host command.
 *
 * 2. **The outcome is a status from a nine-word vocabulary.** See
 *    `commandStatusSchema` above.
 *
 * **Why the target stays host-and-run.** Appendix A.6 allows nine
 * `target_kind`s on `control.commands`. The ones above host and run —
 * workspace, org, class, tool server, connection — are blast-radius denies and
 * belong to `set_kill_switch` (§6.11); `@<agent-slug>` and `@agents` addressing
 * belongs to `send_message` (§7.6). What is left, and what §7.4's guarantee
 * table is written against, is a command to one host or one run on it.
 */
export const dispatchCommand = defineTool({
  name: "dispatch_command",
  domain: "control",
  description:
    "Queue a pause, resume, steer, cancel, revoke, message, or refresh_bundle command for a host or one run on it, with a §7.3 delivery mode.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,

  absorbs: ["dispatch_tacho_command"],
  renames: [
    {
      from: "sessionUuid",
      source: "dispatch_tacho_command",
      to: "runId",
      why: "§3's locked vocabulary — *session* survives only as the harness's synonym for a run, and an interface field says `run`. Carried by reference from `dispatch_tacho_command.input.shape.sessionUuid`, so the uuid bound and the optionality (omitted targets the host) travel with the new name.",
    },
  ],
  drops: [
    {
      field: 'command: "kill"',
      from: "dispatch_tacho_command",
      why: "§7.4 folds process kill into `cancel` (SIGTERM where the collector owns the process, best effort and recorded). Appendix A.6's `kill_switch_on`/`kill_switch_off` are §6.11 blast-radius denies and belong to `set_kill_switch`.",
    },
    {
      field: "outcome (output)",
      from: "dispatch_tacho_command",
      why: "replaced by `status` on §7.4's nine-word closed vocabulary — `pending`/`delivered` collapse the distinctions §7.4 and §7.6 exist to preserve. See commandStatusSchema.",
    },
  ],

  /**
   * v1 declared no agent metadata because it was API-only. Exposing it on MCP
   * means a model can reach it, so a grade is required: high, and approval is
   * required. `cancel` revokes a run token and `revoke` kills a credential —
   * an agent that can issue either can halt the fleet, which is precisely the
   * §6.11 blast radius a human is meant to decide on.
   */
  agent: { requiresApproval: true, riskLevel: "high", category: "control" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // Writes a control.commands row (Appendix A.6).
  mutates: true,

  input: z.object({
    // Required, as in v1. A command is delivered through a connection point,
    // and the host is what owns one — a run id alone does not say where to
    // deliver.
    hostEnrollmentId: tachoCommandDispatch.input.shape.hostEnrollmentId,
    /**
     * Carried from `sessionUuid` under §3's vocabulary ("avoid *session* except
     * as the harness's synonym for run"). Optional: omitted targets the host,
     * which is how `revoke` and `refresh_bundle` are addressed.
     */
    runId: tachoCommandDispatch.input.shape.sessionUuid,

    /**
     * The v1 enum minus `kill`, plus `steer`. Composed rather than retyped so
     * that adding a command to the wire enum reaches this tool automatically.
     */
    command: z.union([
      tachoCommandSchema.exclude(["kill"]),
      z.literal("steer"),
    ]),

    /**
     * §7.3. Ignored for commands that carry no prompt content (`pause`,
     * `resume`, `cancel`, `revoke`, `refresh_bundle`) — those land at the next
     * boundary by definition. First-class rather than a `payload` key because
     * the mode is a governed choice with a cost: `interrupt` bills partial
     * model output and abandons tool work, and it degrades to `next_step`
     * behind an irreversible tool call or at `harness` tier.
     */
    deliveryMode: deliveryModeSchema.default("next_step"),

    /** `steer` and `message` carry `{ text }`; `pause` and `cancel` may carry `{ reason }`. */
    payload: tachoCommandDispatch.input.shape.payload,

    /**
     * 10s to 24h, default one hour. The ceiling matters: §7.4 distinguishes
     * `expired` ("the run never reached a boundary") from `cancelled`, and a
     * command with no expiry could never reach the first.
     */
    expiresInS: tachoCommandDispatch.input.shape.expiresInS,
  }),

  output: z.object({
    commandId: tachoCommandDispatch.output.shape.commandId,
    /**
     * At dispatch this is `queued` or `failed`; it advances on the control
     * channel as the host takes and applies the command. `applied` is the only
     * success status.
     */
    status: commandStatusSchema,
    issuedAt: tachoCommandDispatch.output.shape.issuedAt,
    expiresAt: tachoCommandDispatch.output.shape.expiresAt,
  }),
});

export type DispatchCommandInput = z.output<typeof dispatchCommand.input>;
export type DispatchCommandOutput = z.output<typeof dispatchCommand.output>;
