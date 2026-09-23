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
 * The pending queue as a page reads it: the approvals themselves, and whether
 * the read stopped before the end of the queue.
 *
 * `list_approvals` answers at most 100 rows a page, and the Fleet waiting tile
 * counts what this carries. Counting one page read as a fact: a workspace with
 * 140 parked calls showed 100 and said nothing, and 100 is the figure an
 * operator would have staffed against. So the read walks the cursor to the end
 * of the queue, and `more` says when a bound stopped it, which is what lets the
 * tile read "1,000+" instead of a number it cannot stand behind.
 */
export const ApprovalQueue = z.object({
  items: z.array(ApprovalItem),
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
