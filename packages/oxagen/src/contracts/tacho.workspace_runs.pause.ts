/**
 * `pause_workspace_runs` (#3862): pause every live wrapped run in the
 * workspace as one governed decision, with one audit event.
 *
 * `dispatch_command` with target `{ kind: "workspace" }` already queues the
 * same pauses. This capability exists for what that one does not carry:
 *
 * - narrower roles: org Owner and Admin and workspace Owner, and no Member;
 * - approval before the in-app agent can call it;
 * - a receipt that separates the runs that took the pause from the runs that
 *   were skipped, and says why each was skipped;
 * - one `tacho.workspace_runs_paused` security event per decision.
 *
 * An `observe`-tier run on a host that is polling takes the pause (ADR-163).
 * Only a run `commandBlockOf` calls unreachable is skipped, and the handler
 * writes a `failed` command row for it so `list_commands` stays complete.
 * Ledger runs (`arun_…`) are left alone: this pauses wrapped runs only.
 *
 * The workspace is the caller's scope (INV-29), so the input names none. A
 * control command is never refused for lack of governed action units, so a
 * lapsed bucket cannot leave agents unstoppable (`noBillingGate: true`).
 */
import { z } from "zod";
import { COMMAND_REASON_MAX } from "../tacho/command-limits";
import { registerCapability } from "../registry";
import { COMMAND_BLOCKS, runPublicIdSchema } from "./run.list";

export const pauseWorkspaceRuns = registerCapability({
  name: "pause_workspace_runs",
  domain: "control",
  description:
    "Queue a pause for every live wrapped run in the workspace that its host can reach, as one governed decision with one audit event, and answer which runs took it and which were skipped and why.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  agent: { requiresApproval: true, riskLevel: "high", category: "control" },
  input: z
    .object({
      /** Why the runs are paused. Each run reads it on resume. */
      reason: z.string().min(1).max(COMMAND_REASON_MAX),
    })
    .strict(),
  output: z
    .object({
      /** How many runs took the pause. Equal to `commandIds.length`. */
      queued: z.number().int().nonnegative(),
      /**
       * The `tcm_…` ids of the queued rows only, in the order they were
       * written. Unlike `dispatch_command`, this list holds no failed rows.
       */
      commandIds: z.array(z.string().min(1)),
      /** The live runs no host could reach, each with the failed row written for it. */
      skipped: z.array(
        z
          .object({
            runId: runPublicIdSchema,
            agentKey: z.string().min(1).max(128),
            reason: z.enum(COMMAND_BLOCKS),
            commandId: z.string().min(1),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type PauseWorkspaceRunsInput = z.output<typeof pauseWorkspaceRuns.input>;
export type PauseWorkspaceRunsOutput = z.output<
  typeof pauseWorkspaceRuns.output
>;
