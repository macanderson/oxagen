// statement.ts: the in-toto Statement v1 that records one done-record verdict.
//
// agent-work-spec.html (Done record, Attestation): the subject is the pull
// request's head commit, the predicate type is DONE_RECORD_PREDICATE_TYPE, and
// the predicate holds the record digest, the verdict, each criterion's state
// with its evidence, and the models the gateway recorded per stage. The record
// digest is the record's lock digest, the same value `work/done.verdict`
// carries as `record_digest`.
//
// The predicate holds ids, states, digests, and model routes. It never holds a
// criterion's text, so outside text from an issue never reaches the envelope.
import { assertDigest, type Sha256Digest } from "@oxagen/run-evidence";
import type { CriterionEvidence, DoneOutcome } from "../decide";
import {
  CRITERION_STATES,
  DONE_REASON_CODES,
  DONE_RECORD_PREDICATE_TYPE,
  DONE_VERDICTS,
  MAX_CRITERIA,
  type CriterionState,
  type DoneReasonCode,
  type DoneVerdict,
  type WorkItemId,
} from "../types";

export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const DSSE_IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CRITERION_ID = /^[a-z0-9-]{1,40}$/;
const WORK_ITEM_ID = /^wi_[0-9A-Za-z]{1,64}$/;
const MAX_LABEL = 200;
const MAX_STAGE_MODELS = 32;

/** The pull request head commit the statement is about. */
export interface DoneAttestationSubject {
  /** The repository's https URL. */
  name: string;
  digest: { gitCommit: string };
}

/** What one criterion's evidence was when the verdict changed. */
export interface DonePredicateEvidence {
  check?: { ok: boolean; digest: Sha256Digest; error?: true };
  oracle?: { ok: boolean; digest: Sha256Digest; contained: boolean; model: string };
  signature?: { by: string; at: string };
}

export interface DonePredicateCriterion {
  id: string;
  state: CriterionState;
  evidence: DonePredicateEvidence;
}

export interface DonePredicateReason {
  code: DoneReasonCode;
  criterion?: string;
}

/** The predicate of a done-record attestation. */
export interface DonePredicate {
  item: WorkItemId;
  /** The record's lock digest. */
  record_digest: Sha256Digest;
  verdict: DoneVerdict;
  reasons: DonePredicateReason[];
  criteria: DonePredicateCriterion[];
  /** The model route the gateway recorded for each stage, by stage. */
  stage_models: Record<string, string>;
  /** An RFC 3339 date-time. */
  decided_at: string;
}

export interface DoneStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: [DoneAttestationSubject];
  predicateType: typeof DONE_RECORD_PREDICATE_TYPE;
  predicate: DonePredicate;
}

/** Everything `doneStatement` needs for one verdict change. */
export interface DoneStatementInput {
  item: WorkItemId;
  /** The repository's https URL, such as https://github.com/acme/api. */
  repository: string;
  /** The pull request's head commit. */
  commit: string;
  /** The record's lock digest. */
  recordDigest: Sha256Digest;
  /** What decide returned. */
  outcome: DoneOutcome;
  /** The evidence decide read. Evidence for a criterion the outcome lacks is refused. */
  evidence?: readonly CriterionEvidence[];
  /** The model route the gateway recorded for each stage, by stage. */
  stageModels?: Readonly<Record<string, string>>;
  decidedAt: Date;
}

function fail(message: string): never {
  throw new TypeError(`done attestation: ${message}`);
}

function label(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "" || value.length > MAX_LABEL) {
    fail(`${what} must be a string of 1 to ${MAX_LABEL} characters`);
  }
  return value;
}

function repositoryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("repository must be an https URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    fail("repository must be an https URL with no credentials");
  }
  return label(value, "repository");
}

function predicateEvidence(evidence: CriterionEvidence | undefined): DonePredicateEvidence {
  const out: DonePredicateEvidence = {};
  if (evidence?.check) {
    const { ok, evidence: digest, error } = evidence.check;
    out.check = { ok, digest: assertDigest(digest) };
    if (error === true) out.check.error = true;
  }
  if (evidence?.oracle) {
    const { ok, evidence: digest, contained, model } = evidence.oracle;
    out.oracle = { ok, digest: assertDigest(digest), contained, model: label(model, "oracle model") };
  }
  if (evidence?.signature) {
    const { by, at } = evidence.signature;
    out.signature = { by: label(by, "signature by"), at: label(at, "signature at") };
  }
  return out;
}

function predicateCriteria(
  outcome: DoneOutcome,
  evidence: readonly CriterionEvidence[],
): DonePredicateCriterion[] {
  if (outcome.criteria.length > MAX_CRITERIA) {
    fail(`a record holds at most ${MAX_CRITERIA} criteria`);
  }
  const byId = new Map<string, CriterionEvidence>();
  for (const entry of evidence) byId.set(entry.id, entry);
  const seen = new Set<string>();
  const criteria = outcome.criteria.map(({ id, state }) => {
    if (!CRITERION_ID.test(id)) fail(`criterion id ${JSON.stringify(id)} is not a criterion id`);
    if (seen.has(id)) fail(`criterion ${id} appears twice`);
    seen.add(id);
    if (!(CRITERION_STATES as readonly string[]).includes(state)) {
      fail(`criterion ${id} has an unknown state`);
    }
    return { id, state, evidence: predicateEvidence(byId.get(id)) };
  });
  for (const id of byId.keys()) {
    if (!seen.has(id)) fail(`evidence names criterion ${JSON.stringify(id)}, which the outcome lacks`);
  }
  return criteria;
}

function predicateReasons(outcome: DoneOutcome): DonePredicateReason[] {
  return outcome.reasons.map(({ code, criterion }) => {
    if (!DONE_REASON_CODES.includes(code)) fail(`unknown reason code ${JSON.stringify(code)}`);
    if (criterion === undefined) return { code };
    if (!CRITERION_ID.test(criterion)) fail(`reason ${code} names a bad criterion id`);
    return { code, criterion };
  });
}

function stageModels(models: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(models);
  if (entries.length > MAX_STAGE_MODELS) fail(`at most ${MAX_STAGE_MODELS} stage models`);
  const out: Record<string, string> = {};
  for (const [stage, model] of entries) {
    out[label(stage, "stage")] = label(model, `model for stage ${stage}`);
  }
  return out;
}

/** The in-toto statement for one verdict change. Throws TypeError on bad input. */
export function doneStatement(input: DoneStatementInput): DoneStatement {
  if (!COMMIT_SHA.test(input.commit)) fail("commit must be a 40 or 64 character lowercase hex sha");
  if (!WORK_ITEM_ID.test(input.item)) fail("item must be a work item id");
  if (!(DONE_VERDICTS as readonly string[]).includes(input.outcome.verdict)) {
    fail("verdict must be pending, held, proven, or broken");
  }
  if (Number.isNaN(input.decidedAt.getTime())) fail("decidedAt must be a valid date");
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: repositoryUrl(input.repository), digest: { gitCommit: input.commit } }],
    predicateType: DONE_RECORD_PREDICATE_TYPE,
    predicate: {
      item: input.item,
      record_digest: assertDigest(input.recordDigest),
      verdict: input.outcome.verdict,
      reasons: predicateReasons(input.outcome),
      criteria: predicateCriteria(input.outcome, input.evidence ?? []),
      stage_models: stageModels(input.stageModels ?? {}),
      decided_at: input.decidedAt.toISOString(),
    },
  };
}
