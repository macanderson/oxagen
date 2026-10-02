// accept.ts: Accept and Read checks, which read GitHub at the press (P1-04).
//
// agent-work-phase-1.html, Delivery and review: "Before accepting, retrieve
// current required checks for the exact head SHA. Missing, failing,
// cancelled, or skipped required checks keep acceptance blocked." So Accept
// reads the pull request, the checks its base branch requires, and each
// check's conclusion on the head again, every time a person presses it.
//
// A network read cannot sit inside the transaction that holds the item's row
// lock, so Accept takes three steps:
//
//   1. Read the item and the send, with no lock.
//   2. Read GitHub, then record what it found as provider facts in a
//      transaction of their own (evidence.ts). The evidence stays recorded
//      even when the acceptance is refused, so the page shows the failing
//      check the refusal names.
//   3. Record the acceptance in a second transaction, naming the version the
//      evidence write left. The store admits it against the projection that
//      already holds the fresh evidence, so a failing or missing required
//      check, or a new head, refuses it.
//
// The person's own read is checked against the version before step 2's
// write: if anything else changed the item since they read it, the
// acceptance is refused as stale. Anything that lands between steps 2 and 3,
// such as a webhook's new head, makes step 3 stale too.
//
// A read of the required checks that failed blocks the acceptance outright,
// even when an older read of the same head is on record: the rule is a read
// at the press.
import type { Tx } from "@oxagen/database";
import type { Sha256Digest } from "@oxagen/run-evidence";
import { WorkRecordError } from "@oxagen/work/records";
import { itemAfter, orderAfter, resolveItemId, resolveOrder } from "./actions";
import type { WorkActor } from "./actor";
import { type EvidenceReader, type EvidenceSummary, evidenceFacts, readEvidence } from "./evidence";
import { appendFacts, readWorkItem, type WorkScope, type WorkWrite } from "./store";

/** Opens one tenant transaction. Handlers pass `withTenantDb`. */
export type TenantDb = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** The seams Accept and Read checks need. */
export interface ReviewDeps {
  db: TenantDb;
  reader: EvidenceReader;
  now(): Date;
}

interface Located {
  itemId: string;
  orderId: string;
  orderPublicId: string;
}

async function locate(deps: ReviewDeps, scope: WorkScope, itemPublicId: string, orderPublicId: string) {
  return deps.db(async (tx) => {
    const itemId = await resolveItemId(tx, scope, itemPublicId);
    const order = await resolveOrder(tx, scope, itemId, orderPublicId);
    const record = await readWorkItem(tx, scope, itemId);
    const projected = record.projection.orders.find((entry) => entry.orderId === order.id);
    if (projected === undefined) throw new WorkRecordError("not_found", "This work item has no such send.");
    const located: Located = { itemId, orderId: order.id, orderPublicId: order.publicId };
    return { located, projected };
  });
}

/** Read GitHub for one send and record what it found. */
async function recordEvidence(deps: ReviewDeps, scope: WorkScope, itemPublicId: string, orderPublicId: string): Promise<{ located: Located; write: WorkWrite; summary: EvidenceSummary }> {
  const { located, projected } = await locate(deps, scope, itemPublicId, orderPublicId);
  const read = await readEvidence(deps.reader, scope, projected);
  const { facts, summary } = evidenceFacts(projected, read, deps.now().toISOString());
  const write = await deps.db((tx) => appendFacts(tx, scope, { itemId: located.itemId, facts }));
  return { located, write, summary };
}

export interface RefreshChecksAction {
  item_id: string;
  work_order_id: string;
}

/** Read checks: record the send's current pull request evidence and say what was read. */
export async function refreshWorkChecks(deps: ReviewDeps, scope: WorkScope, input: RefreshChecksAction) {
  const { write, summary } = await recordEvidence(deps, scope, input.item_id, input.work_order_id);
  return {
    item: itemAfter(write),
    repeat: write.repeat,
    head_sha: summary.head,
    required_checks: summary.requiredChecks,
    unread_reason: summary.unreadReason,
  };
}

export interface AcceptAction {
  item_id: string;
  version: number;
  work_order_id: string;
  head_sha: string;
  brief_digest: string;
  criteria: string[];
}

/** Accept a send's result on its head commit, after reading GitHub at the press. */
export async function acceptWork(deps: ReviewDeps, scope: WorkScope, actor: WorkActor, input: AcceptAction) {
  const { located, write: evidence, summary } = await recordEvidence(deps, scope, input.item_id, input.work_order_id);
  const before = evidence.repeat ? evidence.version : evidence.version - 1;
  const already = evidence.projection.orders.find((entry) => entry.orderId === located.orderId)?.acceptance;
  const repeatOfThis = already !== null && already !== undefined && already.headSha === input.head_sha && already.briefDigest === input.brief_digest;
  if (!repeatOfThis && before !== input.version) {
    throw new WorkRecordError(
      "stale_version",
      `You read version ${input.version} of the work item, and it is now at version ${before}. Read it again.`,
    );
  }
  // With no pull request or no head yet, the store's own gate refuses below
  // with the reason (no_pull_request, no_head). With one, an unread required
  // list refuses here, whatever an older read of the head recorded.
  if (!repeatOfThis && summary.head !== null && summary.requiredChecks === null) {
    const why = summary.unreadReason ?? "the read failed";
    throw new WorkRecordError(
      "not_allowed",
      `Oxagen could not read the checks this pull request needs on ${input.head_sha.slice(0, 7)} (${why}). Accept stays blocked until it can.`,
    );
  }
  const write = await deps.db((tx) =>
    appendFacts(tx, scope, {
      itemId: located.itemId,
      expectedVersion: evidence.version,
      actorUserId: actor.userId,
      facts: [
        {
          kind: "accepted",
          source: "person",
          itemRevision: 1,
          orderId: located.orderId,
          headSha: input.head_sha,
          briefDigest: input.brief_digest as Sha256Digest,
          actor: actor.userId,
          occurredAt: new Date(0).toISOString(),
          dedupeKey: "accepted",
          data: { criteria: [...input.criteria], required_checks: [] },
        },
      ],
    }),
  );
  const accepted = write.projection.orders.find((entry) => entry.orderId === located.orderId)?.acceptance;
  return {
    item: itemAfter(write),
    repeat: write.repeat,
    order: orderAfter(write.projection, located.orderId, located.orderPublicId),
    required_checks: accepted?.requiredChecks ?? [],
  };
}
