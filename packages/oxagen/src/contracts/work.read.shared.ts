/**
 * Shared shapes for the Work pages' reads (P1-05, #5163; agent-work-phase-1.html,
 * Screens). Not a capability.
 *
 * The reads answer what the pages draw, decided on the server from the work
 * records (ADR-244): the item's state, what it waits for, the latest send, the
 * required checks on the pull request's head, and what the runs cost. The
 * page maps each code to its own words. A work item grants no authority, so
 * none of these fields says what a person may do except `viewer`, which the
 * read computes from the same role check every action makes.
 *
 * Everything here restates `@oxagen/work/records`, which this package does not
 * depend on. A handler test holds the lists equal.
 */
import { z } from "zod";
import { workItemIdSchema, workPrioritySchema, workItemStateSchema } from "./work.intake.shared";
import {
  WORK_ACTION_CLOSE_RESOLUTIONS,
  WORK_ACTION_CRITERION_TAGS,
  WORK_ACTION_DELIVERY_STATES,
  WORK_ACTION_INTENTS,
  WORK_ACTION_PROVENANCES,
  workDigestSchema,
  workHeadShaSchema,
  workOrderIdSchema,
} from "./work.order.shared";

export { workItemIdSchema };

/** The four tabs of the Work page. */
export const WORK_TABS = ["inbox", "running", "review", "done"] as const;
export const workTabSchema = z.enum(WORK_TABS);

/**
 * The word a page shows beside an item's dot. It refines the item state with
 * the facts around it: a `new` item is triaging until triage fails, a `held`
 * item is a possible duplicate or out of scope, a `sent` item reads no answer
 * once its host took the command and has not claimed it, and a `review` item
 * reads accepted once a person accepted its head commit, unless the Oxagen
 * GitHub App merged it.
 */
export const WORK_ITEM_STATUSES = [
  "triaging",
  "triage_failed",
  "needs_info",
  "possible_duplicate",
  "out_of_scope",
  "brief_to_approve",
  "changed",
  "ready",
  "send_rejected",
  "waiting_for_claim",
  "no_answer",
  "running",
  "stopping",
  "in_review",
  "accepted",
  "done",
  "closed",
] as const;
export const workItemStatusSchema = z.enum(WORK_ITEM_STATUSES);

/** A runtime's enforcement tier: before a model call on gateway and contained, after the run on harness and observe. */
export const workRuntimeTierSchema = z.enum(["contained", "gateway", "harness", "observe"]);

/** A check's conclusion on a commit (CHECK_CONCLUSIONS in @oxagen/work/records). */
export const workCheckConclusionSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
  "action_required",
  "stale",
  "pending",
]);

/**
 * The required checks on the head commit, as one word: every required check
 * passed, one failed, one has not reported, one is still running, nobody has
 * read them for this head, the base branch requires none, or there is no
 * pull request to judge.
 */
export const WORK_CHECKS_WORDS = [
  "passing",
  "failing",
  "missing",
  "running",
  "unread",
  "none_required",
  "no_pull_request",
  "pr_closed",
] as const;
export const workChecksWordSchema = z.enum(WORK_CHECKS_WORDS);

/** Why Accept is closed on a send (REVIEW_BLOCKS in @oxagen/work/records). */
export const workReviewBlockSchema = z.enum([
  "order_closed",
  "merged_by_app",
  "already_accepted",
  "run_active",
  "pr_closed",
  "no_pull_request",
  "no_head",
  "brief_out_of_date",
  "checks_unknown",
  "check_missing",
  "check_failed",
]);

/** Whether Accept is open, and if not, the reason and its detail (a check name, a head). */
export const workGateSchema = z
  .object({
    open: z.boolean(),
    block: workReviewBlockSchema.nullable(),
    detail: z.string().nullable(),
  })
  .strict();

/** Money as the record holds it: integer micros and a currency. */
export const workMoneySchema = z
  .object({
    micros: z.string().regex(/^-?[0-9]+$/),
    currency: z.string().min(3).max(3),
  })
  .strict();

/**
 * What the runs behind an item cost, with its coverage. A run that reported
 * no usage has no cost, and its cost stays unknown: `total` sums only the
 * runs whose cost is known, and is null when none is.
 */
export const workCostSchema = z
  .object({
    runs: z.number().int().nonnegative(),
    known_runs: z.number().int().nonnegative(),
    total: workMoneySchema.nullable(),
  })
  .strict();

/** The priority a person sees: triage's suggestion or a person's correction, with the reason and the rules it cites. */
export const workPriorityViewSchema = z
  .object({
    label: workPrioritySchema.nullable(),
    by: z.enum(["oxagen", "person"]).nullable(),
    /** Triage's reason. Null when a person set the priority. */
    reason: z.string().nullable(),
    /** The priorities rules triage cited, as `<lineage>#<number>`. */
    cites: z.array(z.string()),
    /** The name of the person who set it, when a person did. */
    set_by: z.string().nullable(),
  })
  .strict();

/**
 * What an item waits for, as one code and the facts the page needs to say it.
 * Every name is a display name the server resolved, and every time an ISO
 * 8601 string. Source text is never in here, except a triage question and a
 * person's reason, which the page renders as text.
 */
export const workWaitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("triaging") }).strict(),
  z.object({ kind: z.literal("triage_failed"), reason: z.string() }).strict(),
  z.object({ kind: z.literal("needs_info"), question: z.string().nullable() }).strict(),
  z
    .object({
      kind: z.literal("possible_duplicate"),
      of: z.object({ id: workItemIdSchema, number: z.string() }).strict().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("out_of_scope") }).strict(),
  z
    .object({
      kind: z.literal("brief_to_approve"),
      /** Triage drafted criteria and no person saved a brief yet. */
      from_triage: z.boolean(),
      reopened: z.object({ by: z.string().nullable(), at: z.string(), reason: z.string() }).strict().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("brief_to_write") }).strict(),
  z
    .object({
      kind: z.literal("changed"),
      /** `source` when the issue changed after approval, `brief` when a person edited an approved brief. */
      cause: z.enum(["source", "brief"]),
      at: z.string().nullable(),
      approved_revision: z.number().int().positive().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      /** How the last send ended, when one did: the item came back to ready. */
      last_send: z
        .object({
          delivery: z.enum(["withdrawn", "stopped", "returned"]),
          at: z.string().nullable(),
          reason: z.string().nullable(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("send_rejected"), at: z.string().nullable(), reason: z.string() }).strict(),
  z
    .object({
      kind: z.literal("waiting_for_claim"),
      runtime: z.string().nullable(),
      sent_at: z.string(),
      last_poll_at: z.string().nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("no_answer"), runtime: z.string().nullable(), last_poll_at: z.string().nullable() })
    .strict(),
  z
    .object({
      kind: z.literal("running"),
      /** The source moved past the brief the run was sent with. */
      changed_since_send: z.boolean(),
      changed_at: z.string().nullable(),
      brief_revision: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("stopping"), runtime: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("ready_for_review"), head: workHeadShaSchema }).strict(),
  z.object({ kind: z.literal("no_required_checks"), head: workHeadShaSchema }).strict(),
  z
    .object({
      kind: z.literal("check_failed"),
      check: z.string(),
      conclusion: workCheckConclusionSchema,
      head: workHeadShaSchema,
    })
    .strict(),
  z.object({ kind: z.literal("check_missing"), check: z.string(), head: workHeadShaSchema }).strict(),
  z.object({ kind: z.literal("checks_running"), head: workHeadShaSchema }).strict(),
  z.object({ kind: z.literal("checks_unread"), head: workHeadShaSchema }).strict(),
  z
    .object({
      kind: z.literal("new_head"),
      head: workHeadShaSchema,
      earlier: workHeadShaSchema,
      at: z.string().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("no_pull_request") }).strict(),
  /** A pull request is linked and Oxagen has not read its head commit yet. */
  z.object({ kind: z.literal("no_head") }).strict(),
  z.object({ kind: z.literal("pr_closed"), at: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("merged_before_review"), at: z.string() }).strict(),
  /**
   * The Oxagen GitHub App merged the pull request: the agent merged its own
   * work with the push token Oxagen issued it. No acceptance finishes the
   * send, so a person returns the work or closes the item. `login` is the
   * app's GitHub login and `at` the merge time.
   */
  z.object({ kind: z.literal("merged_by_app"), login: z.string(), at: z.string() }).strict(),
  z.object({ kind: z.literal("brief_out_of_date") }).strict(),
  z
    .object({ kind: z.literal("accepted_waiting_merge"), by: z.string().nullable(), head: workHeadShaSchema })
    .strict(),
  z
    .object({
      kind: z.literal("done"),
      /** The person's acceptance and the head commit it was given on. */
      accepted: z.object({ by: z.string().nullable(), at: z.string(), head: workHeadShaSchema }).strict(),
      merged_at: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("closed"),
      resolution: z.enum(WORK_ACTION_CLOSE_RESOLUTIONS),
      by: z.string().nullable(),
      at: z.string(),
      reason: z.string(),
    })
    .strict(),
]);

/** The agent a send went to, by name. Null fields when the agent row is gone. */
export const workAgentRefSchema = z
  .object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    harness: z.string().nullable(),
  })
  .strict();

/**
 * A send's pull request, by repository and number, from the send's facts. Its
 * head is the one acceptance and the required checks are judged on (ADR-251).
 * `url` is the forge store's link when it holds the same pull request.
 */
export const workPullRequestRefSchema = z
  .object({
    repository: z.string(),
    number: z.number().int().positive(),
    url: z.string(),
    head: workHeadShaSchema.nullable(),
  })
  .strict();

/** The pull request states the forge store records, with a draft as its own state. */
const WORK_FORGE_PULL_REQUEST_STATES = ["open", "draft", "closed", "merged"] as const;

/**
 * One pull request a send has, as the forge store last recorded it (ADR-292).
 * A send can have more than one. These say what the pull request is and its
 * state now. Acceptance, the checks, and the gate still read the send's facts.
 */
export const workForgePullRequestSchema = z
  .object({
    /** The forge store's id (`fpr_…`). */
    id: z.string(),
    provider: z.enum(["github", "gitlab"]),
    /** Lower-cased owner/name, or the GitLab project path. */
    repository: z.string(),
    number: z.number().int().positive(),
    url: z.string(),
    /** The title as the forge last reported it. Text from outside the workspace: render it as text. */
    title: z.string().nullable(),
    state: z.enum(WORK_FORGE_PULL_REQUEST_STATES),
    /** The head commit the forge last reported. */
    head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    /** When Oxagen last read the state. */
    state_seen_at: z.string(),
  })
  .strict();

/** The latest send of an item, as a list row shows it. */
export const workSendSummarySchema = z
  .object({
    id: workOrderIdSchema,
    send: z.number().int().positive(),
    key: z.string(),
    delivery: z.enum(WORK_ACTION_DELIVERY_STATES),
    /** The host took the work order command and has not claimed it. */
    no_answer: z.boolean(),
    agent: workAgentRefSchema,
    runtime: z.object({ name: z.string().nullable(), tier: workRuntimeTierSchema }).strict(),
    requested_at: z.string(),
    pull_request: workPullRequestRefSchema.nullable(),
    /** Every pull request the send has in the forge store, newest first. */
    pull_requests: z.array(workForgePullRequestSchema),
    checks: workChecksWordSchema,
    gate: workGateSchema,
    /** A person accepted the pull request's current head. */
    accepted: z.boolean(),
  })
  .strict();

/** One work item, as the Work page's tables show it. */
export const workItemRowSchema = z
  .object({
    id: workItemIdSchema,
    /** The workspace's number for the item, such as WI-19. */
    number: z.string(),
    /** The source's title. Text from outside the workspace: render it as text. */
    title: z.string(),
    origin: z.enum(["provider", "email", "slack", "csv", "manual"]),
    source_url: z.string().nullable(),
    /** The repository the item came from, as owner/name. Null for an item a person entered without one. */
    repository: z.string().nullable(),
    /** The requester as the source named them. Text, never mapped to a user. */
    requester: z.string().nullable(),
    labels: z.array(z.string()),
    arrived_at: z.string(),
    /** When it was done or closed. Null while it is open. */
    finished_at: z.string().nullable(),
    state: workItemStateSchema,
    status: workItemStatusSchema,
    tab: workTabSchema,
    /** Name this version on the next action. */
    version: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    priority: workPriorityViewSchema,
    wait: workWaitSchema,
    /** The latest send since the last reopen, or null. */
    send: workSendSummarySchema.nullable(),
    cost: workCostSchema,
  })
  .strict();

/** What the viewer may do on the Work pages, from the same role check each action makes. */
export const workViewerSchema = z
  .object({
    /** Enter items, correct triage, write briefs, send, stop, return, close, reopen. */
    can_control: z.boolean(),
    /** Approve a brief and accept work. */
    can_approve: z.boolean(),
  })
  .strict();

/** One criterion of a brief. `criterion` is the stable id, such as c3. */
export const workCriterionSchema = z
  .object({
    criterion: z.string().regex(/^c[1-9][0-9]{0,5}$/),
    text: z.string(),
    tag: z.enum(WORK_ACTION_CRITERION_TAGS),
    intent: z.enum(WORK_ACTION_INTENTS),
    evidence: z.string(),
    provenance: z.enum(WORK_ACTION_PROVENANCES),
  })
  .strict();

/** One saved brief revision. */
export const workBriefSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive(),
    item_revision: z.number().int().positive(),
    digest: workDigestSchema,
    repository: z.string(),
    /** Who wrote it: a person's name, or null for triage. */
    author: z.string().nullable(),
    saved_at: z.string(),
    criteria: z.array(workCriterionSchema),
    /** The approval of this revision, when a person approved it. */
    approved: z.object({ by: z.string().nullable(), at: z.string() }).strict().nullable(),
  })
  .strict();

export type WorkItemRowOutput = z.output<typeof workItemRowSchema>;
export type WorkWaitOutput = z.output<typeof workWaitSchema>;
