/**
 * get_work_outcomes: what the workspace's Phase 1 work finished in a window
 * of days (P1-05, #5163; agent-work-phase-1.html, Screens: Outcome view, and
 * Release gates: the measures).
 *
 * Every figure is counted from the work records (ADR-244), never estimated:
 *
 *   - Accepted and merged, returned, and closed are separate counts and never
 *     add into one rate. An item counts as accepted and merged in the window
 *     when the later of its acceptance and its merge falls in it.
 *   - Lead time runs from the item's first source reading (collected or
 *     entered) to the later of acceptance and merge, with its median, its
 *     90th percentile, and its sample.
 *   - Review touches count a person's decisions on the accepted items: brief
 *     approvals, acceptances, returns, triage overrides, and triage
 *     corrections.
 *   - Cost sums the runs linked to the accepted items' sends whose cost the
 *     rollup recorded. A run with no recorded cost stays unknown and adds
 *     nothing. In-app triage spend is not here: it shows on Billing.
 *   - Reopens count only items that finished 30 or more days ago, and say how
 *     many newer items wait for their 30 days. Reverts are not recorded.
 *   - Delivery counts the sends a person made in the window, each in one
 *     bucket: rejected, claimed, withdrawn before a claim, or waiting. The
 *     four buckets add up to the sends.
 *   - Claim time runs from a send to the runtime's first claim, over the
 *     claimed sends, with its median, its 90th percentile, and its sample.
 *   - Each week counts the items that entered Work and the sends a person
 *     made. Both counts are exact and never stop at a cap.
 *   - A week used the full flow when at least one item was accepted and
 *     merged in it.
 *
 * Delivery and the weekly counts are the pilot's measures
 * (agent-work-phase-1.html, Release gates). No figure here decides the pilot.
 * A person reads them and decides.
 *
 * The figures assess the workflow, never a person: nothing here names one.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workMoneySchema } from "./work.read.shared";

export const workOutcomesGet = registerCapability({
  name: "get_work_outcomes",
  domain: "work",
  description:
    "Count the workspace's work accepted and merged, returned, and closed in a window of days, with lead time, review touches, cost coverage, and reopens.",
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
  input: z
    .object({
      days: z.number().int().min(7).max(90).default(30),
    })
    .strict(),
  output: z
    .object({
      days: z.number().int().positive(),
      since: z.string(),
      accepted_merged: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      closed: z
        .object({
          cancelled: z.number().int().nonnegative(),
          declined: z.number().int().nonnegative(),
          duplicate: z.number().int().nonnegative(),
        })
        .strict(),
      lead_time: z
        .object({
          median_hours: z.number().nonnegative().nullable(),
          p90_hours: z.number().nonnegative().nullable(),
          sample: z.number().int().nonnegative(),
        })
        .strict(),
      touches: z
        .object({
          /** Touches per accepted item. Null with no accepted item. */
          per_item: z.number().nonnegative().nullable(),
          brief_approvals: z.number().int().nonnegative(),
          acceptances: z.number().int().nonnegative(),
          returns: z.number().int().nonnegative(),
          triage_overrides: z.number().int().nonnegative(),
          triage_corrections: z.number().int().nonnegative(),
        })
        .strict(),
      cost: z
        .object({
          runs: z.number().int().nonnegative(),
          known_runs: z.number().int().nonnegative(),
          total: workMoneySchema.nullable(),
        })
        .strict(),
      reopens: z
        .object({
          /** Items that finished 30 or more days ago. */
          cohort: z.number().int().nonnegative(),
          reopened: z.number().int().nonnegative(),
          /** Items that finished in the last 30 days and wait to count. */
          waiting: z.number().int().nonnegative(),
        })
        .strict(),
      /** The sends a person made in the window. The four buckets add up to `sends`. */
      delivery: z
        .object({
          sends: z.number().int().nonnegative(),
          /** Sends a runtime claimed and that were not rejected. */
          claimed: z.number().int().nonnegative(),
          /** Sends the runtime or Oxagen refused or could not keep. */
          rejected: z.number().int().nonnegative(),
          /** Sends a person withdrew before any claim. */
          withdrawn: z.number().int().nonnegative(),
          /** Sends with no claim, rejection, or withdrawal yet. */
          waiting: z.number().int().nonnegative(),
          /** Minutes from each claimed send to its first claim. Null with no sample. */
          claim_minutes: z
            .object({
              median: z.number().nonnegative().nullable(),
              p90: z.number().nonnegative().nullable(),
              sample: z.number().int().nonnegative(),
            })
            .strict(),
        })
        .strict(),
      /**
       * More items finished, or more sends were made, than one read counts.
       * Those figures cover the newest of them. The weekly entered and sent
       * counts never stop at a cap.
       */
      truncated: z.boolean(),
      weeks: z.array(
        z
          .object({
            /** The Monday the week starts, as YYYY-MM-DD in UTC. */
            week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            accepted_merged: z.number().int().nonnegative(),
            returned: z.number().int().nonnegative(),
            median_lead_hours: z.number().nonnegative().nullable(),
            /** Items whose first source reading, collected or entered, fell in the week. */
            entered: z.number().int().nonnegative(),
            /** Sends a person made in the week. */
            sent: z.number().int().nonnegative(),
            /** True when at least one item was accepted and merged in the week. */
            full_flow: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type WorkOutcomesGetOutput = z.output<typeof workOutcomesGet.output>;
