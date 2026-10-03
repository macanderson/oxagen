/**
 * get_work_item: one work item with everything a person decides on (P1-05,
 * #5163; agent-work-phase-1.html, Screens: Work item).
 *
 * The answer is read from the item's records and reduced from its facts on
 * the server (ADR-244): the source and its revisions, triage with every
 * correction in force (effectiveTriage), every brief revision and its
 * approval, every send with its delivery, runs, pull request, required
 * checks, acceptance, and cost, and the history in time order. The source's
 * text is untrusted data: the page renders it as text and nothing here
 * treats it as an instruction.
 *
 * `next_send` is the key the next send must carry
 * (`<item>:r<brief revision>:s<send>`), fixed before the person presses
 * Send, so a retry reuses it. `viewer` says which actions the person's roles
 * admit, from the same check each action makes. The actions check again on
 * the server, so the page's copy decides nothing.
 *
 * `item` takes the workspace number (WI-12) or the public id (wi_…). A read
 * never calls GitHub. It shows what Oxagen last recorded, and
 * refresh_work_order_checks reads GitHub again.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { triageStandingSchema, triageViewSchema } from "./work.intake.shared";
import { WORK_ACTION_DELIVERY_STATES, workDigestSchema, workHeadShaSchema, workOrderIdSchema } from "./work.order.shared";
import {
  workAgentRefSchema,
  workBriefSchema,
  workCheckConclusionSchema,
  workChecksWordSchema,
  workCostSchema,
  workForgePullRequestSchema,
  workGateSchema,
  workItemRowSchema,
  workMoneySchema,
  workPullRequestRefSchema,
  workRuntimeTierSchema,
  workViewerSchema,
} from "./work.read.shared";

/** One recorded reading of the source: what the item said at that revision. */
const sourceRevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    at: z.string(),
    /** `collected` from a collector, `entered` by a person, `changed` for a later reading. */
    kind: z.enum(["collected", "entered", "changed"]),
    subject: z.string(),
    description: z.string().nullable(),
    labels: z.array(z.string()),
  })
  .strict();

/** A check's conclusion on one head commit. */
const checkSchema = z
  .object({ name: z.string(), conclusion: workCheckConclusionSchema, required: z.boolean() })
  .strict();

/** A person's acceptance of one head commit. */
const acceptanceSchema = z
  .object({
    head: workHeadShaSchema,
    by: z.string().nullable(),
    at: z.string(),
    /** The criterion ids the person ticked. */
    criteria: z.array(z.string()),
    /** The checks the base branch required on that head when the person accepted. */
    required_checks: z.array(z.string()),
  })
  .strict();

/** A corrected triage field's value: a priority, an estimate in minutes, or a list. */
const correctionValueSchema = z.union([z.string(), z.number(), z.array(z.string())]);

/** A reason a person gave, with who and when. */
const reasonedSchema = z.object({ reason: z.string(), by: z.string().nullable(), at: z.string() }).strict();

/** One send of the item, with everything its review rests on. */
const sendSchema = z
  .object({
    id: workOrderIdSchema,
    send: z.number().int().positive(),
    key: z.string(),
    delivery: z.enum(WORK_ACTION_DELIVERY_STATES),
    /** The host took the work order command and has not claimed it. */
    no_answer: z.boolean(),
    /** The send is over: another may start. */
    ended: z.boolean(),
    item_revision: z.number().int().positive(),
    brief_revision: z.number().int().positive(),
    brief_digest: workDigestSchema,
    agent: workAgentRefSchema,
    runtime: z.object({ name: z.string().nullable(), tier: workRuntimeTierSchema }).strict(),
    host: z.object({ name: z.string(), last_poll_at: z.string().nullable() }).strict().nullable(),
    /** The person who sent it. */
    operator: z.string().nullable(),
    /** The agent's mandate at send (mnd_…), or null when it had none. The work item adds no authority. */
    mandate_id: z.string().nullable(),
    requested_at: z.string(),
    delivered_at: z.string().nullable(),
    claimed_at: z.string().nullable(),
    first_run_at: z.string().nullable(),
    run_ended_at: z.string().nullable(),
    rejected: z.object({ reason: z.string(), at: z.string() }).strict().nullable(),
    withdrawn: reasonedSchema.nullable(),
    stop_requested: reasonedSchema.nullable(),
    stopped_at: z.string().nullable(),
    returned: reasonedSchema.nullable(),
    runs: z.array(
      z
        .object({
          /** The run's public id (arun_… or tse_…). */
          id: z.string(),
          /** Null when the run reported no usage or has not been rolled up. */
          cost: workMoneySchema.nullable(),
          /** How the cost was measured, as the rollup recorded it. */
          basis: z.string().nullable(),
          tier: z.string().nullable(),
        })
        .strict(),
    ),
    cost: workCostSchema,
    pull_request: workPullRequestRefSchema
      .extend({
        head_at: z.string().nullable(),
        merged: z.object({ at: z.string(), merge_commit: workHeadShaSchema }).strict().nullable(),
        closed_at: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /** Every pull request the send has in the forge store, newest first. */
    pull_requests: z.array(workForgePullRequestSchema),
    /** The checks the base branch requires on the head. Null until Oxagen reads them for this head. */
    required_checks: z.array(z.string()).nullable(),
    checks: z.array(checkSchema),
    /** The latest results recorded on an earlier head. They decide nothing on the current head. */
    earlier_checks: z.object({ head: workHeadShaSchema, checks: z.array(checkSchema) }).strict().nullable(),
    checks_word: workChecksWordSchema,
    gate: workGateSchema,
    acceptance: acceptanceSchema.nullable(),
    /** An acceptance on an earlier head. It counts for nothing and stays visible. */
    stale_acceptance: acceptanceSchema.nullable(),
    /** The agent's claims on criteria. Nothing records one in Phase 1 yet. */
    claims: z.array(
      z
        .object({
          criterion: z.string(),
          text: z.string(),
          head: workHeadShaSchema.nullable(),
          current: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

/** One fact in the item's history, with the details a page names. */
const historySchema = z
  .object({
    kind: z.string(),
    source: z.enum(["provider", "runtime", "agent", "person", "oxagen"]),
    /** The actor's display name: a person, a host, or null for Oxagen and the provider. */
    actor: z.string().nullable(),
    at: z.string(),
    item_revision: z.number().int().positive(),
    /** The send the fact belongs to, or null for an item fact. */
    send: z.number().int().positive().nullable(),
    reason: z.string().nullable(),
    resolution: z.string().nullable(),
    outcome: z.string().nullable(),
    head: workHeadShaSchema.nullable(),
    check: z.string().nullable(),
    conclusion: z.string().nullable(),
    pull_request: z.string().nullable(),
    merge_commit: z.string().nullable(),
    brief_revision: z.number().int().positive().nullable(),
  })
  .strict();

export const workItemGet = registerCapability({
  name: "get_work_item",
  domain: "work",
  description:
    "Read one work item with its source revisions, triage, brief revisions, sends, pull request checks, acceptance, cost, and history.",
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
      /** The workspace number (WI-12) or the public id (wi_…). */
      item: z.string().trim().min(1).max(64),
    })
    .strict(),
  output: z
    .object({
      item: workItemRowSchema
        .extend({
          /** The source's description. Text from outside the workspace: render it as text. */
          description: z.string().nullable(),
          source_revisions: z.array(sourceRevisionSchema),
          /** The collector that brought it in, or null for an item a person entered. */
          collector: z
            .object({ name: z.string(), health: z.enum(["healthy", "lagging", "failing", "paused"]) })
            .strict()
            .nullable(),
        })
        .strict(),
      triage: z
        .object({
          view: triageViewSchema,
          standing: triageStandingSchema,
          decided_at: z.string().nullable(),
          /** The model the decision recorded. Null when nothing recorded it. */
          model: z.string().nullable(),
          failure: z.object({ reason: z.string(), at: z.string() }).strict().nullable(),
          /** A person's override of triage's outcome, while it is in force. */
          override: z
            .object({ outcome: z.string(), reason: z.string(), by: z.string().nullable(), at: z.string() })
            .strict()
            .nullable(),
          corrections: z.array(
            z
              .object({
                field: z.enum(["priority", "estimate_minutes", "labels", "claims", "criteria"]),
                /** The value before the change, or null when the field had none. */
                before: correctionValueSchema.nullable(),
                /** The person's value, or null when the person cleared the correction. */
                after: correctionValueSchema.nullable(),
                by: z.string().nullable(),
                at: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
      brief: z
        .object({
          /** none: nothing to approve; triage_draft: triage drafted criteria nobody saved; draft: a saved revision waits for approval; approved; out_of_date: the approval is on an earlier item revision. */
          state: z.enum(["none", "triage_draft", "draft", "approved", "out_of_date"]),
          /** Every saved revision, oldest first. */
          revisions: z.array(workBriefSchema),
          /** Triage's drafted criteria, when no person has saved a brief. */
          triage_criteria: z.array(z.string()),
          /** The repository a new brief starts with: the latest brief's, else the item's. */
          repository: z.string().nullable(),
        })
        .strict(),
      /** The key and number of the next send, when the approved brief allows one. */
      next_send: z.object({ send: z.number().int().positive(), key: z.string() }).strict().nullable(),
      /** Every send, newest first. */
      sends: z.array(sendSchema),
      history: z.array(historySchema),
      viewer: workViewerSchema,
    })
    .strict(),
});

export type WorkItemGetInput = z.input<typeof workItemGet.input>;
export type WorkItemGetOutput = z.output<typeof workItemGet.output>;
