// work.intake.shared.ts: the shapes the work intake and triage contracts
// share (P1-03, #5103; agent-work-phase-1.html). Not a capability.
import { z } from "zod";

/** A work item's public id. */
export const workItemIdSchema = z
  .string()
  .regex(/^wi_[0-9A-Za-z]+$/, "A work item id starts with wi_.");

/** A Priority label (tasks-spec.md §6.4). */
export const workPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

/** What triage decided about an item (triage/v1 state). */
export const triageOutcomeSchema = z.enum(["triaged", "needs_info", "duplicate", "out_of_scope"]);

/** A work item's state (ADR-244, WORK_ITEM_STATES in @oxagen/work). */
export const workItemStateSchema = z.enum([
  "new",
  "held",
  "triaged",
  "needs_info",
  "changed",
  "ready",
  "sent",
  "running",
  "review",
  "done",
  "closed",
]);

/** A repository as owner/name. */
export const repositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/, "Name a repository as owner/name.");

/** One suggestion field, and whether triage or a person set it. */
function triageField<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      value: value.nullable(),
      /** `oxagen` for a triage suggestion, `person` for a correction, null when neither set it. */
      by: z.enum(["oxagen", "person"]).nullable(),
      /** The user id of the person who corrected it. */
      actor: z.string().nullable(),
      at: z.string().nullable(),
    })
    .strict();
}

/** A triage suggestion with every correction in force (effectiveTriage in @oxagen/work). */
export const triageViewSchema = z
  .object({
    /** The triage decision's public id (`tri_…`), or null when triage has not decided. */
    decision: z.string().nullable(),
    priority: triageField(workPrioritySchema),
    priority_reason: z.string().nullable(),
    cites: z.array(z.string()),
    estimate_minutes: triageField(z.number().int().nonnegative()),
    labels: triageField(z.array(z.string())),
    claims: triageField(z.array(z.string())),
    criteria: triageField(z.array(z.string())),
    questions: z.array(z.string()),
    duplicates: z.array(workItemIdSchema),
    related: z.array(workItemIdSchema),
    conflicts: z.array(z.string()),
  })
  .strict();

/** Where triage stands on an item (the item's reduced triage). */
export const triageStandingSchema = z
  .object({
    /** The outcome in force, `failed` when the latest run failed, or null before triage ran. */
    outcome: z.enum(["triaged", "needs_info", "duplicate", "out_of_scope", "failed"]).nullable(),
    /** `person` when a person's override is in force. */
    by: z.enum(["oxagen", "person"]).nullable(),
    duplicate_of: workItemIdSchema.nullable(),
  })
  .strict();

/** A collector's health. */
export const collectorHealthSchema = z.enum(["healthy", "lagging", "failing", "paused"]);

/** One collector's setup and health. */
export const workCollectorSchema = z
  .object({
    /** The work.collectors row's id. */
    collector_id: z.string().uuid(),
    name: z.string(),
    type: z.literal("github"),
    /** The GitHub connection's public id (`con_…`), or null when it no longer resolves. */
    connection_id: z.string().nullable(),
    repos: z.array(repositoryNameSchema),
    health: collectorHealthSchema,
    /** Where the next reconcile starts reading, as the provider's update time. */
    cursor: z.string().nullable(),
    /** The latest reconcile, finished or failed. Null before the first one. */
    last_reconcile: z
      .object({
        at: z.string(),
        ok: z.boolean(),
        pages: z.number().int().nonnegative(),
        handled: z.number().int().nonnegative(),
        missed: z.number().int().nonnegative(),
        error: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /** When a reconcile last finished. */
    last_success_at: z.string().nullable(),
    /** Failed reconciles since the last one that finished. Three in a row make the collector failing. */
    failed_streak: z.number().int().nonnegative(),
    /** When the next scheduled reconcile reads. Null while paused or failing, which wait for a person. */
    next_check_at: z.string().nullable(),
    /** When the latest webhook delivery arrived. */
    last_event_at: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();

export type WorkCollectorView = z.output<typeof workCollectorSchema>;
export type TriageViewOutput = z.output<typeof triageViewSchema>;
