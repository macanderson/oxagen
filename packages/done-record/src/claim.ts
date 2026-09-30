// claim.ts: an agent's claim on one criterion of a locked done record.
//
// An agent calls claim_dod_item when it believes a criterion is met, with a
// reference to its evidence: a commit, a test, a check run, or a pull request
// (tasks-spec.md §11). A claim is the agent's word. It moves the criterion
// from open to claimed and nothing further: only a check, an oracle, or a
// person's signature makes it held or proven (agent-work-spec.html, Criterion
// states).
import type { Sha256Digest } from "@oxagen/run-evidence";
import type { CriterionEvidence } from "./decide";
import { DoneRecordError } from "./errors";
import { lockMatches } from "./lock-digest";
import { isActor, isRfc3339 } from "./patterns";
import type { DoneRecord } from "./types";

/** The longest evidence reference a claim carries. */
export const CLAIM_REF_MAX_LENGTH = 500;

/** True when the text holds a C0 control character or DEL. A reference is one line of data. */
function hasControl(text: string): boolean {
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) return true;
  }
  return false;
}

/** One agent's claim on one criterion. */
export interface DoneClaim {
  /** The lock digest of the record the claim is on. */
  record: Sha256Digest;
  criterion: string;
  /** The handle of the agent that claims. */
  by: string;
  /** The agent's evidence: a commit, a test, a check run, or a pull request. Stored as data. */
  ref: string;
  /** An RFC 3339 date-time. */
  at: string;
}

/** What an agent sends with claim_dod_item. */
export interface ClaimRequest {
  criterion: string;
  by: string;
  ref: string;
  at: string;
}

/**
 * Check a claim against a locked record and the claims already on it, and
 * return the claim to store. Throws DoneRecordError when the record is not
 * locked, the criterion is unknown, another agent holds the claim, or the
 * request is malformed. The same agent may claim again with new evidence.
 * Pure.
 */
export function claimCriterion(
  record: DoneRecord,
  existing: readonly DoneClaim[],
  request: ClaimRequest,
): DoneClaim {
  const lock = record.lock;
  if (lock === undefined || !lockMatches(record)) {
    throw new DoneRecordError(
      "not_locked",
      "The done record is not locked, or it no longer matches its lock. A person locks it before agents claim criteria.",
    );
  }
  if (!record.criteria.some((criterion) => criterion.id === request.criterion)) {
    throw new DoneRecordError("unknown_criterion", `The done record has no criterion "${request.criterion}".`);
  }
  if (!isActor(request.by)) {
    throw new DoneRecordError("invalid_input", `The claim's handle "${request.by}" is not a workspace handle.`);
  }
  const ref = request.ref.trim();
  if (ref.length === 0 || ref.length > CLAIM_REF_MAX_LENGTH || hasControl(ref)) {
    throw new DoneRecordError(
      "invalid_input",
      `The claim's evidence reference must be one line of 1 to ${CLAIM_REF_MAX_LENGTH} characters.`,
    );
  }
  if (!isRfc3339(request.at)) {
    throw new DoneRecordError("invalid_input", `The claim's time "${request.at}" is not an RFC 3339 date-time.`);
  }
  const held = existing.find(
    (claim) => claim.record === lock.digest && claim.criterion === request.criterion && claim.by !== request.by,
  );
  if (held !== undefined) {
    throw new DoneRecordError(
      "already_claimed",
      `The agent "${held.by}" already claimed "${request.criterion}". One agent claims a criterion.`,
    );
  }
  return { record: lock.digest, criterion: request.criterion, by: request.by, ref, at: request.at };
}

/**
 * Put the claims on a record's evidence, so decide can mark each claimed
 * criterion `claimed` until its check, oracle, or signature settles it. Claims
 * on another lock, or on a criterion the record lacks, are left out. Pure.
 */
export function applyClaims(
  record: DoneRecord,
  criteria: readonly CriterionEvidence[],
  claims: readonly DoneClaim[],
): CriterionEvidence[] {
  const digest = record.lock?.digest;
  const known = new Set(record.criteria.map((criterion) => criterion.id));
  const claimedBy = new Map<string, string>();
  for (const claim of claims) {
    if (claim.record !== digest || !known.has(claim.criterion)) continue;
    if (!claimedBy.has(claim.criterion)) claimedBy.set(claim.criterion, claim.by);
  }
  const out: CriterionEvidence[] = criteria.map((entry) => {
    const by = claimedBy.get(entry.id);
    return by === undefined || entry.claimedBy !== undefined ? { ...entry } : { ...entry, claimedBy: by };
  });
  const present = new Set(criteria.map((entry) => entry.id));
  for (const [id, by] of claimedBy) {
    if (!present.has(id)) out.push({ id, claimedBy: by });
  }
  return out;
}
