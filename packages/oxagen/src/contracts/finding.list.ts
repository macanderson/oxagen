/**
 * `list_findings`: the workspace's costed findings ranked by the money at
 * stake, with the totals the Spend page leads with (Mission Control spec
 * §12.8, App. E; ADR-062). Every figure is the findings job's: the saving is
 * measured minus counterfactual over the cited runs, the annualised figure is
 * each finding's saving scaled from its own window to 365 days, and the share
 * is that annualised saving over the priced spend of the findings' span,
 * scaled the same way. A window or span shorter than
 * ANNUALISED_WINDOW_MIN_DAYS scales as if it were that long, so a finding
 * re-proven minutes after a decision does not scale minutes of runs to a year.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  findingRunCitationSchema,
  findingSchema,
  findingStatusSchema,
} from "./finding.shared";
import { runPublicIdSchema } from "./run.list";
import { costSchema, ratioSchema } from "./spend.shared";

/** A window shorter than this many days annualises as if it were this long. */
export const ANNUALISED_WINDOW_MIN_DAYS = 7;

/** At most this many findings in one answer: the job keeps ten per kind, so every open finding fits (billing's findings test asserts it). */
export const FINDINGS_LIST_MAX = 50;

export const findingList = registerCapability({
  name: "list_findings",
  domain: "spend",
  description:
    "List this workspace's costed findings ranked by the money at stake (open by default; applied or dismissed most recent first), each with its saving measured minus counterfactual over the runs it cites, its confidence, why and the fix, plus the total saving, its share of the priced spend over the findings' window and that saving annualised. Given a run, it lists only the findings that cite that run, each with the frames it cites there.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      status: findingStatusSchema.default("open"),
      /**
       * Lists only the findings that cite this run (`cited_runs @> [runId]`),
       * and the totals cover those findings (#4001).
       */
      runId: runPublicIdSchema.optional(),
    })
    .strict(),
  output: z
    .object({
      status: findingStatusSchema,
      /** The span the listed findings cover; null when none is listed. */
      window: z
        .object({ from: z.string().datetime(), to: z.string().datetime() })
        .strict()
        .nullable(),
      /** The listed findings' savings summed, with the fold of their bases. */
      saving: costSchema.nullable(),
      /** The workspace's priced spend over `window`; null when nothing in it was priced. */
      spend: costSchema.nullable(),
      /** `annualised` over `spend` scaled from `window` (at least ANNUALISED_WINDOW_MIN_DAYS) to 365 days, at most 1. */
      share: ratioSchema.nullable(),
      /** Each listed finding's saving scaled from its own window (at least ANNUALISED_WINDOW_MIN_DAYS) to 365 days, summed. */
      annualised: costSchema.nullable(),
      counts: z
        .object({
          findings: z.number().int().nonnegative(),
          high: z.number().int().nonnegative(),
          medium: z.number().int().nonnegative(),
          /** Distinct operators whose runs the listed findings cite. */
          operators: z.number().int().nonnegative(),
        })
        .strict(),
      findings: z
        .array(
          findingSchema.extend({
            /** What the finding cites in `input.runId`; present exactly when the read names a run. */
            citation: findingRunCitationSchema.optional(),
          }),
        )
        .max(FINDINGS_LIST_MAX),
    })
    .strict(),
});

export type FindingListInput = z.output<typeof findingList.input>;
export type FindingListOutput = z.output<typeof findingList.output>;
