// What the Work walk's seed writes and its walk reads (ADR-255, #5163).
// CI-only: `.github/workflows/work-surfaces-walk.yml` runs `seed.ts` and then
// `walk.ts`, and nothing else does. Neither is an e2e spec (INV-20), and
// nothing under `src/` imports this file (INV-07, INV-22).
//
// This module holds the contract between the seed, the walk, and the Work
// pages:
//
//   - WALK_STATES: one work item per state the Work pages draw, the title the
//     seed enters it under, the state the work records reduce it to, and the
//     tab, status, and wait the pages must show for it;
//   - WALK_TEST_IDS: every `data-testid` the walk presses or reads;
//   - the record `seed:work` writes to `e2e/.auth/work-walk.json`.
//
// It imports no platform package, so the walk loads it without a database.
import path from "node:path";
import { z } from "zod";
import { AUTH_DIR } from "../../e2e/support";

/** The repository every seeded brief and pull request names, as owner/name. */
export const WALK_REPOSITORY = "e2e/demo";

/** The one check the base branch requires on every seeded pull request. */
export const WALK_CHECK = "ci";

/** The GitHub collector the seed adds, in failing health. */
export const WALK_COLLECTOR = "e2e-github";

/** A Work page tab, as `RouteTabs` names it in `data-tab`. */
export type WorkTab = "inbox" | "running" | "review" | "done";

/** A Work setup tab, as `RouteTabs` names it in `data-tab`. */
export type SetupTab = "collectors" | "priorities" | "runtimes";

/** A work item's state, as the work records reduce it (`reduceWorkItem`). */
export type ReducedState =
  | "new"
  | "held"
  | "triaged"
  | "needs_info"
  | "changed"
  | "ready"
  | "sent"
  | "running"
  | "review"
  | "done"
  | "closed";

export type WalkStateKey =
  | "triaging"
  | "triage_failed"
  | "triage_draft"
  | "needs_info"
  | "ready"
  | "possible_duplicate"
  | "waiting_for_claim"
  | "running"
  | "review_passing"
  | "review_failing"
  | "stale_evidence"
  | "merged_before_review"
  | "closed_unmerged"
  | "done"
  | "closed_duplicate";

export type WalkState = {
  readonly key: WalkStateKey;
  /** The subject the seed enters the item under. The seed finds it again by this title. */
  readonly title: string;
  /** What `reduceWorkItem` returns once the seed is done with the item. */
  readonly reduced: ReducedState;
  /** The Work page tab the item is listed on. */
  readonly tab: WorkTab;
  /** The item's `data-status`, on its row and on its page. */
  readonly status: string;
  /** The item's `data-wait`, on its row and on its page. */
  readonly wait: string;
};

/**
 * Every seeded state, in the order the seed enters them. The status and wait
 * codes are the server's (`WorkStatus` and `WorkWait` in
 * src/data/contracts/work.ts). The seed runs every review item through one
 * agent, one after another: each of those sends releases the agent when its
 * run ends, so the agent is free again for the walk's own send.
 */
export const WALK_STATES: readonly WalkState[] = [
  {
    key: "triaging",
    title: "Work walk: triaging",
    reduced: "new",
    tab: "inbox",
    status: "triaging",
    wait: "triaging",
  },
  {
    key: "triage_failed",
    title: "Work walk: triage failed",
    reduced: "new",
    tab: "inbox",
    status: "triage_failed",
    wait: "triage_failed",
  },
  {
    key: "triage_draft",
    title: "Work walk: triage draft",
    reduced: "triaged",
    tab: "inbox",
    status: "brief_to_approve",
    wait: "brief_to_approve",
  },
  {
    key: "needs_info",
    title: "Work walk: needs info",
    reduced: "needs_info",
    tab: "inbox",
    status: "needs_info",
    wait: "needs_info",
  },
  {
    key: "ready",
    title: "Work walk: ready",
    reduced: "ready",
    tab: "inbox",
    status: "ready",
    wait: "ready",
  },
  {
    key: "possible_duplicate",
    title: "Work walk: possible duplicate",
    reduced: "held",
    tab: "inbox",
    status: "possible_duplicate",
    wait: "possible_duplicate",
  },
  {
    key: "waiting_for_claim",
    title: "Work walk: waiting for claim",
    reduced: "sent",
    tab: "running",
    status: "waiting_for_claim",
    wait: "waiting_for_claim",
  },
  {
    key: "running",
    title: "Work walk: running",
    reduced: "running",
    tab: "running",
    status: "running",
    wait: "running",
  },
  {
    key: "review_passing",
    title: "Work walk: review with passing checks",
    reduced: "review",
    tab: "review",
    status: "in_review",
    wait: "ready_for_review",
  },
  {
    key: "review_failing",
    title: "Work walk: review with a failing check",
    reduced: "review",
    tab: "review",
    status: "in_review",
    wait: "check_failed",
  },
  {
    // Accepted on one head, then a newer head arrived with no checks read on
    // it yet. The acceptance counts for nothing and stays on the page.
    key: "stale_evidence",
    title: "Work walk: stale evidence",
    reduced: "review",
    tab: "review",
    status: "in_review",
    wait: "new_head",
  },
  {
    key: "merged_before_review",
    title: "Work walk: merged before review",
    reduced: "review",
    tab: "review",
    status: "in_review",
    wait: "merged_before_review",
  },
  {
    key: "closed_unmerged",
    title: "Work walk: closed without merging",
    reduced: "review",
    tab: "review",
    status: "in_review",
    wait: "pr_closed",
  },
  {
    key: "done",
    title: "Work walk: done",
    reduced: "done",
    tab: "done",
    status: "done",
    wait: "done",
  },
  {
    key: "closed_duplicate",
    title: "Work walk: closed as a duplicate",
    reduced: "closed",
    tab: "done",
    status: "closed",
    wait: "closed",
  },
];

/** The seeded state with this key. */
export function walkState(key: WalkStateKey): WalkState {
  const state = WALK_STATES.find((entry) => entry.key === key);
  if (state === undefined) throw new Error(`No seeded state is named ${key}.`);
  return state;
}

/**
 * Every `data-testid` the walk presses or reads, beside the attributes it
 * reads on list rows (`data-work-item`, `data-status`, `data-wait`) and tabs
 * (`data-tab`). An item page action is `work-action-<name>`, its dialog is
 * `work-dialog-<name>`, and the dialog's confirm is
 * `work-dialog-<name>-submit` (src/features/work/item/work-dialog.tsx).
 */
export const WALK_TEST_IDS = {
  newItem: "work-new-item",
  itemStatus: "work-item-status",
  itemWait: "work-item-wait",
  staleEvidence: "work-stale-evidence",
  actionFailure: "work-action-failure",
  approve: "work-action-approve",
  send: "work-action-send",
  sendAgentPrefix: "work-send-agent-",
  sendSubmit: "work-dialog-send-submit",
  /** Cancel opens the Stop dialog in its cancel form. */
  cancel: "work-action-cancel",
  cancelSubmit: "work-dialog-stop-submit",
  accept: "work-action-accept",
  acceptCriterionPrefix: "work-accept-",
  acceptSubmit: "work-dialog-accept-submit",
  /** Records the answer typed in ANSWER_BOX. */
  answer: "work-action-record-answer",
  /** A possible duplicate's Close: it opens Close with the duplicate resolution chosen. */
  confirmDuplicate: "work-action-confirm-duplicate",
  close: "work-action-close",
  closeAsDuplicate: "work-close-duplicate",
  closeSubmit: "work-dialog-close-submit",
  reopen: "work-action-reopen",
  reopenSubmit: "work-dialog-reopen-submit",
  /** Every item page action starts with this. A viewer refused the page sees none. */
  actionPrefix: "work-action-",
  /** The Work page header's Send to an agent. */
  listSend: "work-send",
} as const;

/** The box triage's question is answered in (src/features/work/item/inline-actions.tsx). */
export const ANSWER_BOX = "#work-answer";

/** A dialog's reason box (src/features/work/item/fields.tsx, ReasonField). */
export const REASON_BOX = 'textarea[name="reason"]';

/**
 * The denied states a refused viewer may see: the Work page's and Work
 * setup's (`work-denied`), the item page's (`work-item-denied`), and the
 * shell's, when the workspace itself is refused (`page-denied`).
 */
export const DENIED_TEST_IDS = ["work-denied", "work-item-denied", "page-denied"] as const;

/** Written by `seed:work` beside `seed.json`, in the gitignored `e2e/.auth/`. */
export const WORK_WALK_RECORD = path.join(AUTH_DIR, "work-walk.json");

const walkStateKeys = WALK_STATES.map((state) => state.key) as [
  WalkStateKey,
  ...WalkStateKey[],
];

/**
 * What `seed:work` writes and `walk.ts` reads: each seeded item's number and
 * public id, the agents the seed sends to, and the criterion keys of the
 * seeded briefs.
 */
export const workWalkRecordSchema = z.object({
  schema: z.literal(1),
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  items: z.record(
    z.enum(walkStateKeys),
    z.object({
      number: z.string().regex(/^WI-[0-9]+$/),
      id: z.string().regex(/^wi_[0-9a-z]+$/),
    }),
  ),
  agents: z.object({
    /** The agent the walk sends to. It holds no open send when the walk starts. */
    send: z.string().regex(/^agt_[0-9a-z]+$/),
    /** The agent the waiting-for-claim item was sent to. */
    queued: z.string().regex(/^agt_[0-9a-z]+$/),
    /** The agent the running item runs on. */
    busy: z.string().regex(/^agt_[0-9a-z]+$/),
  }),
  collector: z.string().min(1),
  /** The criterion keys of every seeded brief, such as c1 and c2. */
  criteria: z.array(z.string().regex(/^c[1-9][0-9]*$/)).min(1),
});
export type WorkWalkRecord = z.infer<typeof workWalkRecordSchema>;
