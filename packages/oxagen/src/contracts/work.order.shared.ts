/**
 * Shared schemas for the Phase 1 work actions (P1-04, ADR-250).
 *
 * A person approves a work item's brief, sends it to an agent, and reviews
 * the pull request the run opened (agent-work-phase-1.html, Work lifecycle).
 * Every action names the work item and the version of it the person read, so
 * the store refuses a decision made on a stale read (ADR-244). The value lists
 * below restate `@oxagen/work/records`, which this package does not depend
 * on. A handler test holds the two copies equal.
 */
import { z } from "zod";

/** A work item's public id. */
export const workItemIdSchema = z.string().regex(/^wi_[0-9a-z]+$/, "a work item id starts with wi_");

/** A work order's public id. */
export const workOrderIdSchema = z.string().regex(/^wo_[0-9a-z]+$/, "a work order id starts with wo_");

/** An agent's public id. */
export const workAgentIdSchema = z.string().regex(/^agt_[0-9a-z]+$/, "an agent id starts with agt_");

/** The item version the person read. The store refuses a decision on another. */
export const workItemVersionSchema = z.number().int().nonnegative();

/** An item or brief revision. */
export const workRevisionSchema = z.number().int().min(1);

/** A brief digest: SHA-256 over the brief in RFC 8785 form. */
export const workDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** A full Git commit id. */
export const workHeadShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "a head commit is 40 lowercase hex characters");

/** A person's reason, kept with the decision. */
export const workReasonSchema = z.string().trim().min(1).max(2000);

/** Where a work item stands (`WORK_ITEM_STATES` in @oxagen/work/records). */
export const WORK_ACTION_ITEM_STATES = [
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
] as const;

/** Where one send stands with its runtime (`DELIVERY_STATES` in @oxagen/work/records). */
export const WORK_ACTION_DELIVERY_STATES = [
  "waiting_for_claim",
  "claimed",
  "running",
  "stopping",
  "run_ended",
  "stopped",
  "returned",
  "withdrawn",
  "rejected",
] as const;

/** How a person closes a work item without finishing it (`CLOSE_RESOLUTIONS`). */
export const WORK_ACTION_CLOSE_RESOLUTIONS = ["cancelled", "declined", "duplicate"] as const;

/** Which kind of work a criterion is about (`BRIEF_CRITERION_TAGS`). */
export const WORK_ACTION_CRITERION_TAGS = ["code", "test", "docs", "review"] as const;

/** How a reviewer settles a criterion (`BRIEF_INTENTS`). */
export const WORK_ACTION_INTENTS = ["check", "review"] as const;

/** Where a criterion came from (`BRIEF_PROVENANCES`). */
export const WORK_ACTION_PROVENANCES = ["source", "triage", "person"] as const;

/** The work item after a write. */
export const workItemAfterSchema = z
  .object({
    id: workItemIdSchema,
    state: z.enum(WORK_ACTION_ITEM_STATES),
    revision: workRevisionSchema,
    /** Name this version on the next decision. */
    version: workItemVersionSchema,
  })
  .strict();

/** One send, as the write left it. */
export const workOrderAfterSchema = z
  .object({
    id: workOrderIdSchema,
    send: z.number().int().min(1),
    /** `<item>:r<brief revision>:s<send>`. A retry of the send names the same key. */
    key: z.string(),
    delivery: z.enum(WORK_ACTION_DELIVERY_STATES),
  })
  .strict();

/** The answer every person's work action gives. */
export const workWriteOutputShape = {
  item: workItemAfterSchema,
  /** True when the action was already recorded as asked and nothing changed. */
  repeat: z.boolean(),
};
