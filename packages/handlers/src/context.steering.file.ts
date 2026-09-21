// context.steering.file.ts — the record file a Context PR commits (ADR-061;
// MC spec §10.2): one `.oxagen/rules/<lineage>.toml` in the context-record/v0.1
// format Stella's loader reads (stella-records/src/ingest/record.rs). The
// record's identity is derived from its content the way Stella derives it:
// pass 1 hashes the record with `record_id` and `record_hash` absent to mint
// `rec_<slug>_<12 hex>`; pass 2 hashes again with the id in the preimage. Only
// fields Stella's `Record` struct carries enter the file, because Stella
// re-serializes the typed struct before it recomputes the hash and would drop
// anything else from its preimage.
import { parse, stringify } from "smol-toml";
import { recordHash } from "@oxagen/run-evidence";
import type {
  PublishedSharingScope,
  RecordForce,
  RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";

export const RECORD_SCHEMA_TAG = "context-record/v0.1";
const RULES_DIR = ".oxagen/rules";

interface RecordFileInput {
  lineageId: string;
  kind: RecordKind;
  force: RecordForce;
  sharingScope: PublishedSharingScope;
  statement: string;
  /** user for a person's proposal, inferred for an agent's (Stella's Origin). */
  origin: "user" | "inferred";
  /** The proposal that carries the rationale and evidence, as provenance. */
  proposalPublicId: string;
  /** The workspace's set id (`<org slug>.<workspace slug>`). */
  setId: string;
}

/** The record as it appears under `[[record]]`, in Stella's field order. */
export interface RecordFileRecord {
  lineage_id: string;
  record_id: string;
  record_hash: string;
  kind: string;
  statement: string;
  origin: string;
  sharing_scope: string;
  status: string;
  provenance: { source_kind: string; source_uri: string };
  steering: { force: string };
}

interface RecordFile {
  schema: string;
  set_id: string;
  record: RecordFileRecord[];
}

/** Stella's `slug()`: strip `ctx.`, lowercase, anything but [a-z0-9] → `_`. */
export function lineageSlug(lineageId: string): string {
  const trimmed = lineageId.startsWith("ctx.") ? lineageId.slice(4) : lineageId;
  return trimmed.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

export function recordFilePath(lineageId: string): string {
  return `${RULES_DIR}/${lineageId}.toml`;
}

export function contextBranch(lineageId: string): string {
  return `context/${lineageId}`;
}

/**
 * Stamp `record_id` and `record_hash` from the content, Stella's two passes,
 * over the record exactly as it will be serialized: every present member
 * enters the preimage, `record_id` and `record_hash` are minted last.
 */
export function stampRecordObject(raw: Record<string, unknown>): {
  record_id: string;
  record_hash: string;
} {
  const { record_id: _id, record_hash: _hash, ...rest } = raw;
  void _id;
  void _hash;
  const lineage = typeof rest.lineage_id === "string" ? rest.lineage_id : "";
  const seed = recordHash(rest);
  const record_id = `rec_${lineageSlug(lineage)}_${seed.slice("sha256:".length, "sha256:".length + 12)}`;
  const record_hash = recordHash({ ...rest, record_id });
  return { record_id, record_hash };
}

/** Stamp a record Oxagen builds, keeping Stella's field order in the file. */
function stampRecord(
  r: Omit<RecordFileRecord, "record_id" | "record_hash">,
): RecordFileRecord {
  const { record_id, record_hash } = stampRecordObject({ ...r });
  return {
    lineage_id: r.lineage_id,
    record_id,
    record_hash,
    kind: r.kind,
    statement: r.statement,
    origin: r.origin,
    sharing_scope: r.sharing_scope,
    status: r.status,
    provenance: r.provenance,
    steering: r.steering,
  };
}

export function buildRecordFile(input: RecordFileInput): RecordFile {
  const record = stampRecord({
    lineage_id: input.lineageId,
    kind: input.kind,
    statement: input.statement,
    origin: input.origin,
    sharing_scope: input.sharingScope,
    status: "active",
    provenance: {
      source_kind: "proposal",
      source_uri: `oxagen:proposal/${input.proposalPublicId}`,
    },
    steering: { force: input.force },
  });
  return { schema: RECORD_SCHEMA_TAG, set_id: input.setId, record: [record] };
}

export function serializeRecordFile(file: RecordFile): string {
  return `${stringify(file)}\n`;
}

/**
 * Parse a record file's text. Throws on invalid TOML; returns the raw object
 * tree for the schema check to validate field by field.
 */
export function parseRecordFile(text: string): unknown {
  return parse(text);
}

/** One record as it was read back out of a file, typed. */
export interface ParsedRecordFile {
  setId: string;
  lineageId: string;
  recordId: string;
  recordHash: string;
  kind: RecordKind;
  force: RecordForce;
  sharingScope: PublishedSharingScope;
  statement: string;
  origin: string;
  status: string;
  /** Where the record came from; a proposal's uri for one Oxagen published. */
  provenanceSourceUri: string | null;
}

const RECORD_KINDS = [
  "rule",
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
] as const;
const RECORD_FORCES = ["must", "should", "may", "info"] as const;
const SHARING_SCOPES = ["repository", "workspace"] as const;

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  return value !== null && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * The first record in a file, typed, or null when the text is not a
 * context-record/v0.1 file with at least one complete record in it.
 *
 * Null rather than a throw: a file that does not parse is a lineage this
 * workspace cannot answer for, which is the same answer as a lineage nothing
 * holds — a 404 the page renders as not-found. A throw here would turn a
 * hand-edited rule file into a 500 on a page whose whole job is to show the
 * reader what is in force.
 */
/**
 * The `[[record]]` table array of a rule file, or null when the file carries
 * none. `Array.isArray` on an `unknown` narrows to `any[]`, which would spread
 * `any` through every field read off it, so the narrowing is spelled out once
 * here and the callers stay typed.
 */
function recordTables(file: Record<string, unknown>): unknown[] | null {
  const records: unknown = file.record;
  if (!Array.isArray(records) || records.length === 0) return null;
  return records as unknown[];
}

export function readRecordFile(text: string): ParsedRecordFile | null {
  let tree: unknown;
  try {
    tree = parse(text);
  } catch {
    return null;
  }
  if (typeof tree !== "object" || tree === null) return null;
  const file = tree as Record<string, unknown>;
  if (file.schema !== RECORD_SCHEMA_TAG) return null;
  const records = recordTables(file);
  if (records === null) return null;
  const first = records[0];
  if (typeof first !== "object" || first === null) return null;
  const raw = first as Record<string, unknown>;

  const lineageId = str(raw, "lineage_id");
  const statement = str(raw, "statement");
  const kind = oneOf(str(raw, "kind"), RECORD_KINDS);
  const sharingScope = oneOf(str(raw, "sharing_scope"), SHARING_SCOPES);
  const steering = raw.steering;
  const force =
    typeof steering === "object" && steering !== null
      ? oneOf(str(steering as Record<string, unknown>, "force"), RECORD_FORCES)
      : null;
  if (!lineageId || !statement || !kind || !sharingScope || !force) return null;

  const provenance = raw.provenance;
  return {
    setId: str(file, "set_id") ?? "",
    lineageId,
    recordId: str(raw, "record_id") ?? "",
    recordHash: str(raw, "record_hash") ?? "",
    kind,
    force,
    sharingScope,
    statement,
    origin: str(raw, "origin") ?? "user",
    status: str(raw, "status") ?? "active",
    provenanceSourceUri:
      typeof provenance === "object" && provenance !== null
        ? str(provenance as Record<string, unknown>, "source_uri")
        : null,
  };
}

/**
 * The same file with one record's statement replaced and its identity
 * re-stamped over the new bytes.
 *
 * Everything else is carried through untouched, including keys Oxagen does not
 * write: a file a person hand-edited is still that person's file, and an
 * revision that silently dropped a field it did not recognise would change
 * the record in ways nobody proposed. The lineage is deliberately preserved —
 * an revised record is the same record, not a new one — while `record_id` and
 * `record_hash` are re-derived, because they are the content's identity and
 * the content just changed. The old hash stays true of every run that carried
 * the old bytes.
 *
 * Returns null when the text is not a record file this can revise, which the
 * caller reports rather than committing a guess.
 */
export function reviseRecordStatement(
  text: string,
  statement: string,
): string | null {
  let tree: unknown;
  try {
    tree = parse(text);
  } catch {
    return null;
  }
  if (typeof tree !== "object" || tree === null) return null;
  const file = tree as Record<string, unknown>;
  if (file.schema !== RECORD_SCHEMA_TAG) return null;
  const records = recordTables(file);
  if (records === null) return null;
  const first = records[0];
  if (typeof first !== "object" || first === null) return null;

  const raw: Record<string, unknown> = {
    ...(first as Record<string, unknown>),
    statement,
  };
  const { record_id, record_hash } = stampRecordObject(raw);
  // Rebuilt key by key rather than spread, so the revised record serializes in
  // Stella's field order: `smol-toml` writes keys in insertion order, and a
  // file whose fields moved reads as a whole-file rewrite in the PR diff.
  const revised: Record<string, unknown> = {};
  for (const key of Object.keys(first as Record<string, unknown>)) {
    if (key === "record_id") revised[key] = record_id;
    else if (key === "record_hash") revised[key] = record_hash;
    else if (key === "statement") revised[key] = statement;
    else revised[key] = raw[key];
  }
  if (!("record_id" in revised)) revised.record_id = record_id;
  if (!("record_hash" in revised)) revised.record_hash = record_hash;
  if (!("statement" in revised)) revised.statement = statement;

  return `${stringify({ ...file, record: [revised, ...records.slice(1)] })}\n`;
}
