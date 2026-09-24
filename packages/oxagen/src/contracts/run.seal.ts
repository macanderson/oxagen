/**
 * `seal_run`: a person ends a wrapped run the control plane still reads as
 * live (#4073, ADR-168).
 *
 * A wrapped session seals when its host sends `agent_stop`, or when the
 * control plane closes it after twelve silent hours. A run whose agent
 * finished without either reads as live until then. This seals it now: the
 * root session and every chain of its run still open, recorded as
 * `seal_source = 'operator'` with the outcome `unknown` and an unobserved
 * tail, as the idle close records its own. Unlike that close it is final: a
 * later frame or `agent_stop` neither reopens nor replaces it.
 *
 * In the same transaction it queues `kill` for the agent on the run's host,
 * which the host carries out with SIGKILL and by denying every later tool
 * call. A host that cannot collect a command (`commandBlockOf`) does not stop
 * the seal; the answer says the kill was not sent and why. A ledger run is
 * refused: its producer seals it, and `dispatch_command` cancels its ingress.
 *
 * Org Owner or Admin, or the workspace's Owner, checked in the handler
 * (`assertOrgRole`). Sealing is final and ends another agent's work, so the
 * in-app agent's toolbelt holds the call for a person's approval. A call over
 * the API or MCP runs with its key's creator's roles.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { COMMAND_BLOCKS, runPublicIdSchema } from "./run.list";
import { COMMAND_REASON_MAX } from "../tacho/command-limits";

export const runSeal = registerCapability({
  name: "seal_run",
  domain: "run",
  description:
    "Seal a live or idle-closed wrapped run now, and queue a kill for its agent on the host it runs on when that host can collect a command.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
  // Like a control command, never refused for lack of governed action units:
  // a lapsed bucket must not leave a finished agent running.
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
      runId: runPublicIdSchema,
      /** Why the operator sealed it; recorded on the kill command. */
      reason: z.string().min(1).max(COMMAND_REASON_MAX).optional(),
    })
    .strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      /** RFC 3339; when the control plane sealed the run. */
      sealedAt: z.string().datetime(),
      /** The run's chains this call sealed: the root and any still-open subagent. */
      sessionsSealed: z.number().int().positive(),
      /** What became of the kill for the agent. */
      kill: z.discriminatedUnion("status", [
        z
          .object({
            status: z.literal("queued"),
            /** The `tcm_…` command the host collects on its next poll. */
            commandId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            status: z.literal("not_sent"),
            /** Why no host could collect it (`commandBlockOf`). */
            reason: z.enum(COMMAND_BLOCKS),
          })
          .strict(),
      ]),
    })
    .strict(),
});

export type SealRunInput = z.output<typeof runSeal.input>;
export type SealRunOutput = z.output<typeof runSeal.output>;
