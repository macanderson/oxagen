/**
 * list_work_targets: the workspace's agents, and whether each can take a send
 * now (P1-05, #5163; agent-work-phase-1.html, Screens: Work setup, and the
 * Send dialog).
 *
 * Each agent is read the way send_work_order reads its target (ADR-251): its
 * runtime, the enrolled host that would receive the work order, the tier the
 * send would record, and whether the person reading operates it. `can_take`
 * is false for exactly the reasons the send refuses: the agent is on no
 * runtime, no host is enrolled for it, the host's oxagen build does not take
 * work orders, the person does not operate it, or it is working on another
 * item (one unreleased work order per agent). A host that has not polled in
 * five minutes can still take a send: the order waits until it polls, so
 * `quiet` says so and blocks nothing.
 *
 * The send checks all of this again on the server. This read decides
 * nothing.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workItemIdSchema, workRuntimeTierSchema } from "./work.read.shared";

/** Why an agent cannot take a send now. */
export const WORK_TARGET_REFUSALS = ["no_runtime", "no_host", "host_outdated", "not_operator", "busy"] as const;

export const workTargetsList = registerCapability({
  name: "list_work_targets",
  domain: "work",
  description:
    "List the workspace's agents with their runtime, enrolled host, tier, and whether each can take a send now, with the reason when not.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      agents: z.array(
        z
          .object({
            /** The agent's public id (agt_…). */
            id: z.string(),
            name: z.string(),
            harness: z.string(),
            runtime: z
              .object({
                id: z.string(),
                name: z.string(),
                /** The tier a send would record: where the budget is held. */
                tier: workRuntimeTierSchema,
              })
              .strict()
              .nullable(),
            host: z
              .object({
                name: z.string(),
                last_poll_at: z.string().nullable(),
                takes_work_orders: z.boolean(),
              })
              .strict()
              .nullable(),
            /** The person reading operates this agent. */
            operates: z.boolean(),
            /** The item this agent's unreleased work order belongs to. */
            busy_with: z.object({ id: workItemIdSchema, number: z.string() }).strict().nullable(),
            can_take: z.boolean(),
            reason: z.enum(WORK_TARGET_REFUSALS).nullable(),
            /** The host has not polled in five minutes. A send waits until it does. */
            quiet: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type WorkTargetsListOutput = z.output<typeof workTargetsList.output>;
