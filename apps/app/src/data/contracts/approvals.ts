// A pending tool-call approval as the Fleet approvals panel reads it
// (ARCHITECTURE.md §1.2), from `list_approvals`. The store records no run and
// no agent on an approval today, so both are nullable and null until it does.
import { z } from "zod";
import { PublicId } from "./common";

/**
 * What the workspace's auto-approval clause said about one parked call when it
 * was parked (ADR-070), as `list_approvals` and `get_auto_eligibility` both
 * carry it.
 *
 * It is read, never recomputed. A rule edited since is a different rule than
 * the one that judged this call, so the card shows the recorded evaluation and
 * says so.
 *
 * A reason is a wire code, sometimes with the measure it is about
 * (`measure_above_ceiling:amount`). The app maps a code to its copy and prints
 * an unmapped code as recorded rather than inventing a sentence for it.
 */
export const AutoEligibility = z.object({
  /**
   * The rule that was evaluated, as the store recorded it
   * (`mandate:<id>:human_above:<measure>`, or a workspace rule's own slug).
   *
   * A `Ref` rather than an `Id` because Oxagen neither mints it nor can
   * validate it as a public id (INV-11), the same reason `ApprovalItem.rule`
   * beside it carries the bare noun.
   */
  ruleRef: z.string().min(1),
  /** True when every condition held and no floor applied. */
  ok: z.boolean(),
  /** Every reason it did not qualify; empty when `ok`. */
  reasons: z.array(z.string().min(1)),
  /** True when at least one reason is a floor no rule can lift. */
  floor: z.boolean(),
});
export type AutoEligibility = z.infer<typeof AutoEligibility>;

/**
 * The recorded evaluation as `list_approvals` and `get_auto_eligibility` carry
 * it, under the name the view model gives it.
 *
 * The contract calls the rule `ruleId`. Two callers read it, a live mapper and
 * a server action, and a feature may not import a mapper, so the rename lives
 * here where both may reach it rather than in two copies that drift.
 */
export function toAutoEligibility(
  recorded: {
    ruleId: string;
    ok: boolean;
    reasons: readonly string[];
    floor: boolean;
  } | null,
): AutoEligibility | null {
  return recorded === null
    ? null
    : {
        ruleRef: recorded.ruleId,
        ok: recorded.ok,
        reasons: [...recorded.reasons],
        floor: recorded.floor,
      };
}

/**
 * Who or what closed an approval request that is no longer pending, as the
 * decision dialog names it (#3521).
 *
 * - `person`: somebody answered. `name` is their display name, the label a
 *   reader sees; `id` is their public id (`usr_…`), drawn beside it and
 *   copyable, never as the label. `name` is null for an account with none.
 * - `rule`: an auto-approval rule released it with no person; `rule` is the
 *   rule id, which is its own name.
 * - `none`: nothing recorded a resolver. A mandate revoke or expiry closes
 *   its parked calls this way, and so does a request's own expiry.
 */
export type ApprovalSettlement =
  | {
      by: "person";
      resolution: "approved" | "denied" | "expired";
      id: string;
      name: string | null;
    }
  | {
      by: "rule";
      resolution: "approved" | "denied" | "expired";
      rule: string;
    }
  | { by: "none"; resolution: "approved" | "denied" | "expired" };

/**
 * The settlement `get_auto_eligibility` records, or null while the request is
 * still pending.
 *
 * It reads `state`, never `resolvedBy`, for whether the request is open: a
 * request closed by a mandate revoke or its own expiry has no resolver, and
 * reading a null `resolvedBy` as "still waiting" offered a decision the
 * handler refuses as `approval_expired`.
 */
export function toApprovalSettlement(recorded: {
  state: "pending" | "approved" | "denied" | "expired";
  resolvedBy: string | null;
  resolvedByName: string | null;
}): ApprovalSettlement | null {
  const { state: resolution, resolvedBy } = recorded;
  if (resolution === "pending") return null;
  if (resolvedBy?.startsWith("user:"))
    return {
      by: "person",
      resolution,
      id: resolvedBy.slice("user:".length),
      name: recorded.resolvedByName,
    };
  if (resolvedBy?.startsWith("policy:"))
    return { by: "rule", resolution, rule: resolvedBy.slice("policy:".length) };
  return { by: "none", resolution };
}

/**
 * The longest decision note `resolve_approval` accepts, mirrored from
 * `APPROVAL_NOTE_MAX` on that contract. The decision dialog's textarea caps at
 * it, so the form never takes a note the kernel refuses.
 *
 * A mirror because the dialog is a client component, and the contract module
 * registers its capability at import time (#3521). `approvals.test.ts` holds
 * the mirror equal to the contract.
 */
export const APPROVAL_NOTE_MAX = 2000;

export const ApprovalItem = z.object({
  id: PublicId,
  runId: PublicId.nullable(),
  /** The capability the parked call asked for. */
  tool: z.string().min(1),
  agentKey: z.string().min(1).nullable(),
  /** The person whose turn parked the call. */
  requester: PublicId.nullable(),
  /**
   * The mandate the parked call drew on (`mnd_…`); null on a row the chat
   * approval gate wrote, which draws on no mandate.
   */
  mandateId: PublicId.nullable(),
  /**
   * The rule that parked the call, as the store recorded it
   * (`mandate:<id>:human_above:<measure>` or `…:always_human_for:<tag>`); null
   * on a row the chat approval gate wrote, which no rule parked. It is the
   * fourth hop of the chain a card draws, and a rule id rather than a minted
   * Oxagen public id (INV-11).
   */
  rule: z.string().min(1).nullable(),
  /** The recorded auto-approval evaluation; null when no rule covered the call. */
  autoEligibility: AutoEligibility.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;

/**
 * The pending queue as a page reads it: the first page of approvals, the
 * whole queue's count, and whether the queue holds approvals past that page.
 *
 * `list_approvals` answers at most 100 rows a page and counts the whole queue
 * beside every page (#3521). The read takes one page and the count rather
 * than walking every cursor: the walk cost up to ten serial kernel reads
 * before Fleet could render, and mounted a card with its own decision dialog
 * for every row it took. The Fleet waiting tile and the panel header print
 * `total`. The panel draws the cards in `items`, soonest expiry first, and
 * says it is showing part of the queue when `more` is set.
 */
export const ApprovalQueue = z.object({
  items: z.array(ApprovalItem),
  /**
   * Every pending approval the read's filter matches, across all pages, and
   * never fewer than `items` holds.
   */
  total: z.number().int().nonnegative(),
  /** True when the queue holds approvals past the ones in `items`. */
  more: z.boolean(),
});
export type ApprovalQueue = z.infer<typeof ApprovalQueue>;

// A resolved approval as the Run page's Approvals tab reads it, from
// `list_resolved_approvals` (#3153). Carries what `ApprovalItem` carries plus
// the resolution: when it happened, who or what made it, and, when a
// decision rule released the call with no person, the rule that did.
export const ResolvedApprovalItem = z.object({
  execution: z
    .object({
      status: z.string(),
      runId: PublicId.nullable(),
      reason: z.string().nullable(),
    })
    .optional(),

  id: PublicId,
  runId: PublicId.nullable(),
  tool: z.string().min(1),
  requester: PublicId.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }),
  resolution: z.enum(["approved", "denied", "expired"]),
  /** `user:<usr_…>` or `policy:<rule id>`; null only for the unreachable case of neither being set. */
  resolvedBy: z.string().min(1).nullable(),
  /**
   * The auto-approval rule that resolved this call with no person; null when
   * a person resolved it or no rule covered it. A rule id, not a minted
   * Oxagen public id (INV-11), so it is carried as `…Ref`.
   */
  autoRuleRef: z.string().min(1).nullable(),
});
export type ResolvedApprovalItem = z.infer<typeof ResolvedApprovalItem>;

/**
 * A run's resolved approvals as the Approvals tab reads them, and whether the
 * read stopped before the end of the ledger (#3477).
 *
 * `approvals.resolved` walks `list_resolved_approvals` to the end of its
 * cursor under a bound of 1,000 rows. Before this shape it returned the rows
 * alone and dropped the last cursor, so a run with more than 1,000 resolved
 * calls showed the first 1,000 as the whole ledger. `more` carries that
 * cursor's meaning to the panel, which says the list is partial, and to the
 * tab count, which reads as a floor.
 */
export const ResolvedApprovalLedger = z.object({
  items: z.array(ResolvedApprovalItem),
  /** True when the run holds resolved approvals past the ones in `items`. */
  more: z.boolean(),
});
export type ResolvedApprovalLedger = z.infer<typeof ResolvedApprovalLedger>;
