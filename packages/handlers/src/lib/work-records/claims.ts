// claims.ts: an agent's claim that it met one criterion of the brief
// (ADR-244, ADR-251).
//
// The review step collects the pull request, the provider's check results,
// and the agent's criterion claims (agent-work-phase-1.html, Work lifecycle).
// A claim is the agent's word, recorded as a `criterion_claimed` fact with
// source `agent`. It shows on the work item and moves nothing: a person still
// ticks every criterion and accepts the head commit.
//
// Only the agent working the send may claim, so the claim is bound to the run
// linked to the send (`run_linked`, runtime.ts):
//
//   - An agent run's context names its run. The run must be the send's
//     linked run.
//   - A host key names its host. The host must be the one that claimed the
//     send, and a run must be linked. Ingest links only a run of the claiming
//     host, so that run is the host's, and the claim is filed as it.
//
// Then the claim has to fit the send as it stands: the send is open, the item
// is still at the revision the send went out on, the head commit is the pull
// request's current head, and the criterion is in the brief the send carries.
// Every check reads the item under its row lock. The same claim again on the
// same head records nothing new, whatever the text says.
import type { Tx } from "@oxagen/database";
import { type OrderProjection, type WorkFact, WorkRecordError } from "@oxagen/work/records";
import { type ItemAfter, type OrderAfter, itemAfter, orderAfter, resolveItemId, resolveOrder } from "./actions";
import type { ClaimingHost } from "./runtime";
import { appendFacts, type WorkScope, type WorkWrite } from "./store";

/** Who is claiming: an agent run by its run id, or an enrolled host by its key. */
export type CriterionClaimant = { kind: "run"; runId: string } | { kind: "host"; host: ClaimingHost };

/** A claim as the contract takes it. */
export interface CriterionClaimAction {
  item_id: string;
  work_order_id: string;
  criterion_id: string;
  head_sha: string;
  text: string;
}

/** What a claim answers. */
export interface CriterionClaimResult {
  item: ItemAfter;
  repeat: boolean;
  order: OrderAfter;
  claim: { criterion_id: string; head_sha: string; run_id: string };
}

/** The run linked to the send, or null. The store keeps one link per send. Pure. */
function linkedRunOf(facts: readonly WorkFact[], orderId: string): string | null {
  for (const fact of facts) {
    if (fact.kind === "run_linked" && fact.orderId === orderId) return fact.runId;
  }
  return null;
}

/** The public id of the host that claimed the send, or null. Pure. */
function claimingHostOf(facts: readonly WorkFact[], orderId: string): string | null {
  for (const fact of facts) {
    if (fact.kind === "claimed" && fact.orderId === orderId) return fact.data.host;
  }
  return null;
}

/** The dedupe key of a claim: one per send, criterion, and head commit. Pure. */
function criterionClaimKey(orderId: string, criterionId: string, headSha: string): string {
  return `criterion_claimed:${orderId}:${criterionId}:${headSha}`;
}

/**
 * The run the claim is filed as, or a refusal when the claimant is not the
 * agent working the send. Pure.
 */
function claimingRun(facts: readonly WorkFact[], order: Pick<OrderProjection, "orderId" | "send">, claimant: CriterionClaimant): string {
  const linked = linkedRunOf(facts, order.orderId);
  if (claimant.kind === "run") {
    if (linked === null || claimant.runId !== linked) {
      throw new WorkRecordError(
        "forbidden",
        `This run is not the run working send ${order.send}. Only that run can claim a criterion.`,
      );
    }
    return linked;
  }
  if (claimingHostOf(facts, order.orderId) !== claimant.host.publicId) {
    throw new WorkRecordError(
      "forbidden",
      `This host did not claim send ${order.send}. Only the host running the send can claim a criterion.`,
    );
  }
  if (linked === null) {
    throw new WorkRecordError(
      "not_allowed",
      `No run is linked to send ${order.send} yet. Start the run with oxagen work start, then claim a criterion.`,
    );
  }
  return linked;
}

/** Refuse a claim the send's current state does not allow. Pure. */
function admitClaim(record: WorkWrite, order: OrderProjection, input: CriterionClaimAction): void {
  if (order.closed) {
    throw new WorkRecordError("not_allowed", `Send ${order.send} is over. A claim needs an open send.`);
  }
  if (order.itemRevision !== record.projection.revision) {
    throw new WorkRecordError(
      "stale_revision",
      `Send ${order.send} went out on revision ${order.itemRevision}, and the work item is now at revision ${record.projection.revision}. A claim counts only on the revision the send carries.`,
    );
  }
  if (order.head === null) {
    throw new WorkRecordError(
      "stale_head",
      `Oxagen has not seen a head commit on send ${order.send}'s pull request yet. Claim again once it has.`,
    );
  }
  if (order.head !== input.head_sha) {
    throw new WorkRecordError(
      "stale_head",
      `You named ${input.head_sha.slice(0, 7)}, and the pull request's head is now ${order.head.slice(0, 7)}. Claim on the current head.`,
    );
  }
  const brief = record.briefs.find((stored) => stored.briefId === order.briefId);
  if (brief === undefined) throw new WorkRecordError("not_found", "The work order's brief is missing.");
  if (!brief.brief.criteria.some((criterion) => criterion.id === input.criterion_id)) {
    throw new WorkRecordError(
      "invalid_input",
      `The brief of send ${order.send} has no criterion "${input.criterion_id}".`,
    );
  }
}

/**
 * Record the agent's claim on one criterion of the send's brief, on the pull
 * request's head commit. Runs in the caller's tenant transaction and reads the
 * item under its row lock. A claim never accepts anything.
 */
export async function claimWorkCriterion(
  tx: Tx,
  scope: WorkScope,
  claimant: CriterionClaimant,
  input: CriterionClaimAction,
  now: Date,
): Promise<CriterionClaimResult> {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const ref = await resolveOrder(tx, scope, itemId, input.work_order_id);
  // An append of no facts takes the row lock and writes nothing, so every
  // check below reads the item as the claim will be recorded on it.
  const before = await appendFacts(tx, scope, { itemId, facts: [] });
  const order = before.projection.orders.find((entry) => entry.orderId === ref.id);
  if (order === undefined) throw new WorkRecordError("not_found", "This work item has no such send.");

  const runId = claimingRun(before.facts, order, claimant);
  const dedupeKey = criterionClaimKey(ref.id, input.criterion_id, input.head_sha);
  // A claim already recorded is a repeat, even after the head moved on: the
  // first answer may have been lost, and the claim stands on its own head.
  const repeat = before.facts.some((fact) => fact.dedupeKey === dedupeKey);
  if (!repeat) admitClaim(before, order, input);

  const write = await appendFacts(tx, scope, {
    itemId,
    facts: [
      {
        kind: "criterion_claimed",
        source: "agent",
        itemRevision: order.itemRevision,
        orderId: ref.id,
        headSha: input.head_sha,
        criterionId: input.criterion_id,
        runId,
        actor: runId,
        occurredAt: now.toISOString(),
        dedupeKey,
        data: { text: input.text },
      },
    ],
  });
  return {
    item: itemAfter(write),
    repeat: write.repeat,
    order: orderAfter(write.projection, ref.id, ref.publicId),
    claim: { criterion_id: input.criterion_id, head_sha: input.head_sha, run_id: runId },
  };
}
