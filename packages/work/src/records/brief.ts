// brief.ts: the acceptance brief, work-brief/v1.
//
// A brief is the small completion agreement a person approves before work is
// sent (agent-work-phase-1.html, Data contract). It lists the criteria a
// reviewer checks, each with a stable id, and binds them to one item revision
// and one target repository. It carries no verdict: Phase 1 records what an
// agent claims and what a person accepts, and nothing marks a criterion met.
//
// Every saved revision of a brief is a new immutable row (work.briefs). An
// approval is a fact that names the revision's digest, so the row itself never
// changes. The digest is SHA-256 over the document in RFC 8785 form.
//
// Criterion ids are issued here, never by a caller or a model. An id is `c`
// and a number. A criterion keeps its id through every edit, a removed id is
// never issued again, and a new criterion takes the next number after the
// highest one any revision of the item ever used.
import { digestJcs, type Sha256Digest } from "@oxagen/run-evidence";
import { WorkRecordError } from "./errors";

/** The value of `schema` in a brief. */
export const WORK_BRIEF_SCHEMA = "work-brief/v1" as const;

/** A work item's public id. */
export type WorkItemPublicId = `wi_${string}`;

/** Which kind of work a criterion is about. */
export const BRIEF_CRITERION_TAGS = ["code", "test", "docs", "review"] as const;
export type BriefCriterionTag = (typeof BRIEF_CRITERION_TAGS)[number];

/** How a reviewer settles a criterion: evidence can show it, or a person judges it. */
export const BRIEF_INTENTS = ["check", "review"] as const;
export type BriefIntent = (typeof BRIEF_INTENTS)[number];

/** Where a criterion came from: the source item, the triage suggestion, or a person. */
export const BRIEF_PROVENANCES = ["source", "triage", "person"] as const;
export type BriefProvenance = (typeof BRIEF_PROVENANCES)[number];

/** The most criteria one brief holds. */
export const MAX_BRIEF_CRITERIA = 40;

/** The longest criterion text, in characters. */
export const MAX_CRITERION_TEXT = 2000;

/** The longest expected-evidence text, in characters. */
export const MAX_EVIDENCE_TEXT = 1000;

/** A criterion id: `c` and a number from 1. */
export const CRITERION_ID_PATTERN = /^c[1-9][0-9]{0,5}$/;

/** A GitHub repository as owner/name. */
export const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

const WORK_ITEM_ID_PATTERN = /^wi_[0-9a-z]+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** One thing a reviewer checks before accepting the work. */
export interface BriefCriterion {
  /** Issued by buildBrief. Stable across every revision of the item's brief. */
  id: string;
  text: string;
  tag: BriefCriterionTag;
  intent: BriefIntent;
  /** What the reviewer expects to see, such as a test name or a check. Empty when the criterion names none. */
  evidence: string;
  provenance: BriefProvenance;
}

/** The source a brief was read against. */
export interface BriefSource {
  /** The provider's link to the item. Null for an item a person entered in Oxagen. */
  url: string | null;
  /** The digest of the item's subject, description, and labels at that revision. */
  digest: Sha256Digest | null;
}

/** A work-brief/v1 document. */
export interface WorkBrief {
  schema: typeof WORK_BRIEF_SCHEMA;
  item: WorkItemPublicId;
  /** The item revision the brief was written against. An approval holds while it is current. */
  item_revision: number;
  /** The repository the work changes, as owner/name. */
  repository: string;
  source: BriefSource;
  criteria: BriefCriterion[];
}

/** A criterion as a person or triage submits it. A new criterion has no id. */
export interface BriefDraftCriterion {
  id?: string | null;
  text: string;
  tag: BriefCriterionTag;
  intent: BriefIntent;
  evidence?: string | null;
  provenance: BriefProvenance;
}

/** The editable part of a brief. */
export interface BriefDraft {
  repository: string;
  criteria: BriefDraftCriterion[];
}

/** What buildBrief needs besides the draft. */
export interface BuildBriefInput {
  item: WorkItemPublicId;
  itemRevision: number;
  source: BriefSource;
  draft: BriefDraft;
  /** Every criterion id an earlier revision of this item's brief used. */
  issuedIds: Iterable<string>;
}

function invalid(message: string): WorkRecordError {
  return new WorkRecordError("invalid_input", message);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function criterionNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

/** The number the next new criterion takes, after every id the item ever used. */
export function nextCriterionNumber(issued: Iterable<string>): number {
  let highest = 0;
  for (const id of issued) {
    if (CRITERION_ID_PATTERN.test(id)) highest = Math.max(highest, criterionNumber(id));
  }
  return highest + 1;
}

/** Every criterion id the given brief revisions used. */
export function issuedCriterionIds(briefs: Iterable<Pick<WorkBrief, "criteria">>): Set<string> {
  const ids = new Set<string>();
  for (const brief of briefs) for (const criterion of brief.criteria) ids.add(criterion.id);
  return ids;
}

function checkText(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${label} is missing. Write one sentence a reviewer can check.`);
    return "";
  }
  if (typeof value !== "string") throw invalid(`${label} must be text.`);
  const text = value.trim();
  if (required && text.length === 0) throw invalid(`${label} is empty. Write one sentence a reviewer can check.`);
  if (text.length > max) throw invalid(`${label} is ${text.length} characters. The limit is ${max}.`);
  return text;
}

function checkRepository(value: unknown): string {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) {
    throw invalid(`The repository "${String(value)}" is not owner/name. Name the GitHub repository the work changes.`);
  }
  return value;
}

function checkSource(source: BriefSource): BriefSource {
  if (source.url !== null && typeof source.url !== "string") throw invalid("The source link must be text or null.");
  if (source.digest !== null && !DIGEST_PATTERN.test(source.digest)) {
    throw invalid("The source digest must be sha256: followed by 64 lowercase hex digits.");
  }
  return { url: source.url, digest: source.digest };
}

function checkRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalid(`${label} must be a whole number from 1.`);
  }
  return value;
}

/**
 * Build a brief revision from a draft. Existing criteria keep the ids the
 * draft names, each of which an earlier revision must have issued. New
 * criteria take the next unused numbers in draft order. Pure.
 */
export function buildBrief(input: BuildBriefInput): WorkBrief {
  if (!WORK_ITEM_ID_PATTERN.test(input.item)) throw invalid(`"${input.item}" is not a work item id.`);
  const itemRevision = checkRevision(input.itemRevision, "The item revision");
  const repository = checkRepository(input.draft.repository);
  const source = checkSource(input.source);
  const drafted = input.draft.criteria;
  if (!Array.isArray(drafted) || drafted.length === 0) {
    throw invalid("A brief needs at least one criterion. Add the first thing a reviewer will check.");
  }
  if (drafted.length > MAX_BRIEF_CRITERIA) {
    throw invalid(`A brief holds at most ${MAX_BRIEF_CRITERIA} criteria. This one has ${drafted.length}.`);
  }

  const issued = new Set(input.issuedIds);
  let next = nextCriterionNumber(issued);
  const seen = new Set<string>();
  const criteria = drafted.map((criterion, index): BriefCriterion => {
    const position = `Criterion ${index + 1}`;
    let id: string;
    if (criterion.id === undefined || criterion.id === null) {
      id = `c${next}`;
      next += 1;
    } else {
      if (!issued.has(criterion.id)) {
        throw invalid(`${position} names the id "${criterion.id}", which this item never issued. Leave the id out for a new criterion.`);
      }
      id = criterion.id;
    }
    if (seen.has(id)) throw invalid(`${position} repeats the id "${id}". Each criterion needs its own id.`);
    seen.add(id);
    if (!isOneOf(BRIEF_CRITERION_TAGS, criterion.tag)) {
      throw invalid(`${position} has the tag "${String(criterion.tag)}". Use ${BRIEF_CRITERION_TAGS.join(", ")}.`);
    }
    if (!isOneOf(BRIEF_INTENTS, criterion.intent)) {
      throw invalid(`${position} has the intent "${String(criterion.intent)}". Use check or review.`);
    }
    if (!isOneOf(BRIEF_PROVENANCES, criterion.provenance)) {
      throw invalid(`${position} has the provenance "${String(criterion.provenance)}". Use ${BRIEF_PROVENANCES.join(", ")}.`);
    }
    return {
      id,
      text: checkText(criterion.text, `${position} text`, MAX_CRITERION_TEXT, true),
      tag: criterion.tag,
      intent: criterion.intent,
      evidence: checkText(criterion.evidence, `${position} evidence`, MAX_EVIDENCE_TEXT, false),
      provenance: criterion.provenance,
    };
  });

  return {
    schema: WORK_BRIEF_SCHEMA,
    item: input.item,
    item_revision: itemRevision,
    repository,
    source,
    criteria,
  };
}

/** The brief's digest: SHA-256 over its RFC 8785 form. Pure. */
export function briefDigest(brief: WorkBrief): Sha256Digest {
  return digestJcs(brief);
}

/**
 * Read a stored work-brief/v1 document. Throws invalid_input when the value is
 * not one, so a damaged row never reaches a reviewer as a brief.
 */
export function parseWorkBrief(value: unknown): WorkBrief {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("A brief must be an object.");
  const body = value as Record<string, unknown>;
  if (body["schema"] !== WORK_BRIEF_SCHEMA) throw invalid(`A brief's schema must be ${WORK_BRIEF_SCHEMA}.`);
  const item = body["item"];
  if (typeof item !== "string" || !WORK_ITEM_ID_PATTERN.test(item)) throw invalid("A brief must name its work item.");
  const source = body["source"];
  if (source === null || typeof source !== "object") throw invalid("A brief must name its source.");
  const { url, digest } = source as Record<string, unknown>;
  const criteria = body["criteria"];
  if (!Array.isArray(criteria) || criteria.length === 0) throw invalid("A brief must list its criteria.");
  const ids = criteria.map((criterion: unknown) =>
    criterion !== null && typeof criterion === "object" ? (criterion as Record<string, unknown>)["id"] : undefined,
  );
  for (const id of ids) {
    if (typeof id !== "string" || !CRITERION_ID_PATTERN.test(id)) throw invalid("Every criterion in a stored brief needs an id.");
  }
  // Rebuild through buildBrief so a stored brief meets the same rules as a new one.
  const rebuilt = buildBrief({
    item: item as WorkItemPublicId,
    itemRevision: body["item_revision"] as number,
    source: {
      url: url === undefined ? null : (url as string | null),
      digest: digest === undefined ? null : (digest as Sha256Digest | null),
    },
    draft: {
      repository: body["repository"] as string,
      criteria: criteria as BriefDraftCriterion[],
    },
    issuedIds: ids as string[],
  });
  return rebuilt;
}
