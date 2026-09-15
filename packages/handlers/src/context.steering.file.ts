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
export const RULES_DIR = ".oxagen/rules";

export interface RecordFileInput {
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

export interface RecordFile {
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
export function stampRecord(
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
