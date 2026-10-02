// priorities.ts: the priorities record triage reads (P1-03, #5103).
//
// The priorities record is a steering record, so a person edits it the way
// they edit any record: a Context PR (open_context_pr), merged under the
// workspace's steering rules. Each merge publishes a new version with its own
// checksum, and triage names the version and the hash it read on every
// decision (agent-work-phase-1.html, Data contract).
//
// A workspace's priorities record is its active record whose lineage is
// `work.priorities` or ends in `.work.priorities`, such as
// `aintel.work.priorities` (agent-work-spec.html, Priorities). A workspace
// with none, or with more than one, has no priorities triage can cite, and
// triage records that on the item instead of guessing. ADR-250 records the
// rule.
//
// The rules are the record's statement, numbered `1.`, `2.`, and on, each at
// the start of a line (@oxagen/work priorityCites).
import { createHash } from "node:crypto";
import { schema, type Tx } from "@oxagen/database";
import type { Sha256Digest } from "@oxagen/run-evidence";
import { priorityCites } from "@oxagen/work";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import type { WorkScope } from "../work-records/store";

const records = schema.contextRecords;
const versions = schema.contextRecordVersions;

/** The lineage of a workspace's priorities record, or the end of it. */
export const PRIORITIES_LINEAGE = "work.priorities";

/** One published version of the priorities record. */
export interface PrioritiesRecord {
  lineage: string;
  /** The record's public id (`ctr_…`). */
  recordId: string;
  version: number;
  /** The SHA-256 of the version triage reads, as `sha256:<hex>`. */
  hash: Sha256Digest;
  /** The numbered rules. */
  body: string;
  /** Every cite a triage decision may use, such as `aintel.work.priorities#2`. */
  cites: string[];
  publishedAt: string | null;
}

export type PrioritiesRead =
  | { kind: "found"; record: PrioritiesRecord }
  | { kind: "none" }
  | { kind: "ambiguous"; lineages: string[] };

const HEX64 = /^[0-9a-f]{64}$/;

/** The version's checksum as a digest, or the SHA-256 of the text when the checksum is not one. */
function digestOf(checksum: string, text: string): Sha256Digest {
  const hex = checksum.toLowerCase();
  if (HEX64.test(hex)) return `sha256:${hex}` as Sha256Digest;
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}` as Sha256Digest;
}

/** The message a person reads when the workspace has no single priorities record. */
export function prioritiesProblem(read: Exclude<PrioritiesRead, { kind: "found" }>): string {
  if (read.kind === "none") {
    return `This workspace has no priorities record, so triage has no rules to rank by. Add a steering record named ${PRIORITIES_LINEAGE}, or one whose name ends in .${PRIORITIES_LINEAGE}, with numbered rules, then retry triage.`;
  }
  return `This workspace has more than one priorities record (${read.lineages.join(", ")}), so triage cannot tell which rules to rank by. Retire all but one, then retry triage.`;
}

/** Read the workspace's priorities record at its active version. */
export async function readPriorities(tx: Tx, scope: WorkScope): Promise<PrioritiesRead> {
  const rows = await tx
    .select({
      lineage: records.slug,
      recordId: records.publicId,
      version: versions.versionNumber,
      checksum: versions.checksum,
      statement: versions.statement,
      body: versions.body,
      publishedAt: versions.publishedAt,
    })
    .from(records)
    .innerJoin(versions, eq(versions.id, records.activeVersionId))
    .where(
      and(
        eq(records.orgId, scope.orgId),
        eq(records.workspaceId, scope.workspaceId),
        eq(records.status, "active"),
        isNull(records.deletedAt),
        or(eq(records.slug, PRIORITIES_LINEAGE), ilike(records.slug, `%.${PRIORITIES_LINEAGE}`)),
      ),
    );
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "ambiguous", lineages: rows.map((row) => String(row.lineage)).sort() };
  const row = rows[0]!;
  const lineage = String(row.lineage).toLowerCase();
  const body = row.statement ?? row.body;
  return {
    kind: "found",
    record: {
      lineage,
      recordId: String(row.recordId),
      version: row.version,
      hash: digestOf(row.checksum, body),
      body,
      cites: priorityCites({ lineage, body }),
      publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    },
  };
}
