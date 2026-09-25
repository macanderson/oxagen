// context.steering.sync.plan.ts: what the repository sync (ADR-182) changes
// in the registry, worked out from the record files on the production branch
// and the registry rows, with no I/O. `context.steering.sync.ts` reads both
// sides and writes the plan; this file decides.
//
// A record is matched by the `lineage_id` written inside its file, never by
// the file's name. A person can rename or move a file under `.oxagen/rules/`
// and the record keeps its id, its versions and its ledger; only its `path`
// changes. When the `lineage_id` itself changes in a file that stays at the
// same path, the record keeps its id and takes the new lineage as its slug.
// A lineage that changes in the same commit as a move is a new record, and
// the old one retires.
//
// A file that fails validation publishes nothing, and the record it held
// keeps its last good version. Every such file becomes a finding the Steering
// page and the commit's check show.
import { stringify } from "smol-toml";
import { CONTEXT_RECORD_LINEAGE } from "@oxagen/oxagen/context-record-label";
import type {
  ConstraintEffect,
  PublishedSharingScope,
  RecordForce,
  RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { findSecretsAndPii, parseChecked } from "./context.steering.checks";
import {
  RECORD_SCHEMA_TAG,
  RULES_DIR,
  parseRecordFile,
  stampRecordObject,
} from "./context.steering.file";
import { sha256Hex } from "./registry-digest";

export { RULES_DIR };

/**
 * Files under the rules directory that are not record files. The governance
 * mode lives beside the records and is read on its own at merge time.
 */
const NOT_RECORDS = new Set([`${RULES_DIR}/governance.toml`]);

/** One file as read at the synced commit. */
export interface RepoFile {
  path: string;
  text: string;
}

/** One registry row, as the sync needs it. */
export interface RegistryRecord {
  id: string;
  slug: string;
  path: string | null;
  status: string;
  deleted: boolean;
  label: string | null;
  kind: string | null;
  constraintEffect: string | null;
  statement: string | null;
  /** The in-force version's body, or null when the record has none. */
  body: string | null;
}

export type FindingLevel = "error" | "warning";

export interface SyncFinding {
  level: FindingLevel;
  path: string;
  lineageId: string | null;
  code:
    | "not_toml"
    | "schema"
    | "lineage_invalid"
    | "duplicate_lineage"
    | "secret"
    | "sharing_scope"
    | "constraint_effect"
    | "constraint_conflict"
    | "stale_stamp";
  message: string;
}

export interface RecordContent {
  label: string | null;
  kind: RecordKind;
  force: RecordForce;
  constraintEffect: ConstraintEffect | null;
  sharingScope: PublishedSharingScope;
  statement: string;
}

/** A new version, on a new record or an existing one. */
export interface PlannedPublish {
  /** Null for a lineage the registry has never held. */
  recordId: string | null;
  lineageId: string;
  path: string;
  body: string;
  checksum: string;
  content: RecordContent;
}

/** A change to a record's row that is not a new version. */
export interface PlannedUpdate {
  recordId: string;
  lineageId: string;
  slug?: string;
  path?: string;
  label?: string;
}

export interface PlannedRetire {
  recordId: string;
  lineageId: string;
  reason: "file_removed" | "file_retracted";
}

export interface SyncPlan {
  publish: PlannedPublish[];
  update: PlannedUpdate[];
  retire: PlannedRetire[];
  findings: SyncFinding[];
}

interface Candidate {
  path: string;
  lineageId: string;
  body: string;
  contentKey: string;
  status: string;
  content: Omit<RecordContent, "constraintEffect">;
}

const SHARING: ReadonlySet<string> = new Set(["repository", "workspace"]);

/**
 * The content identity of a record body: the `record_hash` it should carry,
 * recomputed. The label and the stamps are outside it (ADR-178), so a rename
 * or a restamp is not a new version.
 */
export function contentKeyOf(body: string): string | null {
  let tree: unknown;
  try {
    tree = parseRecordFile(body);
  } catch {
    return null;
  }
  const first = recordTables(tree)[0];
  return first ? stampRecordObject(first).record_hash : null;
}

/** The `[[record]]` tables of a parsed file, or none. */
function recordTables(tree: unknown): Record<string, unknown>[] {
  if (typeof tree !== "object" || tree === null) return [];
  const records = (tree as Record<string, unknown>).record;
  if (!Array.isArray(records)) return [];
  return records.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
  );
}

/**
 * The file's text with every missing `record_id` and `record_hash` filled
 * in, or the text itself when every record carries both. A person writing a
 * record by hand cannot compute a SHA-256, so an unstamped record is read as
 * if Oxagen had stamped it, and the file is published as written.
 */
function withStamps(
  text: string,
  tree: Record<string, unknown>,
): {
  text: string;
  unstamped: string[];
} {
  const records = recordTables(tree);
  const unstamped = records.filter(
    (r) => typeof r.record_id !== "string" || typeof r.record_hash !== "string",
  );
  if (unstamped.length === 0) return { text, unstamped: [] };
  const filled = records.map((r) =>
    unstamped.includes(r) ? { ...r, ...stampRecordObject(r) } : r,
  );
  return {
    text: `${stringify({ ...tree, record: filled })}\n`,
    unstamped: unstamped.map((r) =>
      typeof r.lineage_id === "string" ? r.lineage_id : "",
    ),
  };
}

/** Whether a record's path puts it under the sync's care. */
export function isRepositoryRecord(path: string | null): boolean {
  return path !== null && path.startsWith(`${RULES_DIR}/`);
}

const key = (lineage: string) => lineage.toLowerCase();

/** A record file's own findings and candidates. */
function readFile(file: RepoFile): {
  candidates: Candidate[];
  findings: SyncFinding[];
  /** False when the file could not be read as records at all. */
  readable: boolean;
} {
  const finding = (
    code: SyncFinding["code"],
    message: string,
    lineageId: string | null = null,
    level: FindingLevel = "error",
  ): SyncFinding => ({ level, path: file.path, lineageId, code, message });

  let tree: unknown;
  try {
    tree = parseRecordFile(file.text);
  } catch (err) {
    return {
      candidates: [],
      findings: [
        finding(
          "not_toml",
          `${file.path} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ],
      readable: false,
    };
  }
  const table =
    typeof tree === "object" && tree !== null
      ? (tree as Record<string, unknown>)
      : {};
  // A TOML file that declares no records and no record schema is some other
  // configuration kept beside the records. It is not the sync's to judge.
  if (table.schema !== RECORD_SCHEMA_TAG && !("record" in table))
    return { candidates: [], findings: [], readable: true };

  const stamped = withStamps(file.text, table);
  const parsed = parseChecked(stamped.text);
  if (!parsed.ok)
    return {
      candidates: [],
      findings: [finding("schema", `${file.path}: ${parsed.reason}`)],
      readable: false,
    };

  const findings: SyncFinding[] = [];
  const candidates: Candidate[] = [];
  const single = parsed.file.record.length === 1;
  for (const [i, record] of parsed.file.record.entries()) {
    const raw = parsed.file.raw[i]!;
    const lineage = record.lineage_id;
    const unstamped = stamped.unstamped.includes(lineage);
    if (!CONTEXT_RECORD_LINEAGE.test(lineage) || lineage.length > 200) {
      findings.push(
        finding(
          "lineage_invalid",
          `${file.path}: lineage_id "${lineage}" is not a lineage id. Use lowercase letters, digits, dots and hyphens, such as ctx.release.notes-format.`,
          lineage,
        ),
      );
      continue;
    }
    if (!SHARING.has(record.sharing_scope)) {
      findings.push(
        finding(
          "sharing_scope",
          `${file.path}: ${lineage} has sharing_scope "${record.sharing_scope}". A published record is shared with the repository or the workspace.`,
          lineage,
        ),
      );
      continue;
    }
    const leaks = findSecretsAndPii(
      [record.statement, record.label ?? ""].join("\n"),
    );
    if (leaks.length > 0) {
      findings.push(
        finding(
          "secret",
          `${file.path}: ${lineage} carries a ${leaks.join(", ")}. Oxagen did not publish it. Remove it from the file.`,
          lineage,
        ),
      );
      continue;
    }
    const expected = stampRecordObject(raw);
    if (unstamped) {
      findings.push(
        finding(
          "stale_stamp",
          `${file.path}: ${lineage} has no record_id and record_hash. Oxagen published it. Stella's validator reports an unstamped record, so revise it in Oxagen once to write the stamps.`,
          lineage,
          "warning",
        ),
      );
    } else if (
      expected.record_hash !== record.record_hash ||
      expected.record_id !== record.record_id
    ) {
      findings.push(
        finding(
          "stale_stamp",
          `${file.path}: ${lineage} changed after it was stamped, so its record_hash no longer matches its content. Oxagen published the content. Revise the record in Oxagen to write a freshly stamped file.`,
          lineage,
          "warning",
        ),
      );
    }
    const body = single
      ? file.text
      : `${stringify({ schema: RECORD_SCHEMA_TAG, set_id: parsed.file.set_id, record: [raw] })}\n`;
    candidates.push({
      path: file.path,
      lineageId: lineage,
      body,
      contentKey: expected.record_hash,
      status: record.status,
      content: {
        label: record.label?.trim() || null,
        kind: record.kind as RecordKind,
        force: record.steering.force as RecordForce,
        sharingScope: record.sharing_scope as PublishedSharingScope,
        statement: record.statement,
      },
    });
  }
  return { candidates, findings, readable: true };
}

const sameStatement = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The plan that makes the registry match `files`.
 *
 * `defer` names lineages the sync must leave alone this time: a Context PR
 * Oxagen is merging right now publishes them itself, with its reviewer on the
 * ledger, and the next sync finds nothing left to do.
 */
export function planSync(input: {
  files: RepoFile[];
  records: RegistryRecord[];
  defer?: ReadonlySet<string>;
}): SyncPlan {
  const defer = new Set([...(input.defer ?? [])].map(key));
  const findings: SyncFinding[] = [];
  const candidates: Candidate[] = [];
  /** Paths whose file could not be read: whatever they held stays as it is. */
  const unreadable = new Set<string>();
  /** Lineages a finding blocked: their records keep their last good version. */
  const blocked = new Set<string>();

  const files = input.files
    .filter((f) => f.path.endsWith(".toml") && !NOT_RECORDS.has(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) {
    const read = readFile(file);
    findings.push(...read.findings);
    if (!read.readable) unreadable.add(file.path);
    for (const f of read.findings)
      if (f.level === "error" && f.lineageId) blocked.add(key(f.lineageId));
    candidates.push(...read.candidates);
  }

  const bySlug = new Map(input.records.map((r) => [key(r.slug), r]));

  // One lineage, one file. When two files hold a lineage, the one at the
  // registry's path keeps it; with no such file, neither publishes.
  const byLineage = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = key(c.lineageId);
    if (blocked.has(k)) continue;
    byLineage.set(k, [...(byLineage.get(k) ?? []), c]);
  }
  const chosen: Candidate[] = [];
  for (const [k, group] of byLineage) {
    if (group.length === 1) {
      chosen.push(group[0]!);
      continue;
    }
    const registryPath = bySlug.get(k)?.path ?? null;
    const keep = group.find((c) => c.path === registryPath) ?? null;
    for (const c of group) {
      if (c === keep) continue;
      const others = group
        .filter((o) => o !== c)
        .map((o) => o.path)
        .join(", ");
      findings.push({
        level: "error",
        path: c.path,
        lineageId: c.lineageId,
        code: "duplicate_lineage",
        message: `${c.path}: lineage ${c.lineageId} is also in ${others}. Each lineage lives in one file. Remove it from one of them.`,
      });
    }
    if (keep) chosen.push(keep);
    else blocked.add(k);
  }

  // Match each file to a record: by lineage first, then, for a lineage the
  // registry has never held, by the path of a record whose own lineage is no
  // longer in any file (the lineage_id was edited in place).
  const seen = new Set(chosen.map((c) => key(c.lineageId)));
  const claimed = new Set<string>();
  const matches: { c: Candidate; rec: RegistryRecord | null }[] = [];
  const unmatched: Candidate[] = [];
  for (const c of chosen) {
    const rec = bySlug.get(key(c.lineageId)) ?? null;
    if (rec) {
      claimed.add(rec.id);
      matches.push({ c, rec });
    } else unmatched.push(c);
  }
  for (const c of unmatched) {
    const rec =
      input.records.find(
        (r) =>
          !claimed.has(r.id) &&
          !r.deleted &&
          r.status === "active" &&
          r.path === c.path &&
          isRepositoryRecord(r.path) &&
          !seen.has(key(r.slug)) &&
          !blocked.has(key(r.slug)) &&
          !defer.has(key(r.slug)),
      ) ?? null;
    if (rec) claimed.add(rec.id);
    matches.push({ c, rec });
  }

  const plan: SyncPlan = { publish: [], update: [], retire: [], findings };
  const retiring = new Set<string>();
  for (const { c, rec } of matches) {
    if (defer.has(key(c.lineageId))) continue;
    if (c.status !== "active") {
      if (rec && rec.status === "active" && !rec.deleted) {
        plan.retire.push({
          recordId: rec.id,
          lineageId: rec.slug,
          reason: "file_retracted",
        });
        retiring.add(rec.id);
      }
      continue;
    }
    // The record file has no field for a constraint's effect, so the effect
    // stays on the registry row. A constraint the registry has never held as
    // one has no effect to carry.
    let constraintEffect: ConstraintEffect | null = null;
    if (c.content.kind === "constraint") {
      constraintEffect =
        rec?.kind === "constraint"
          ? (rec.constraintEffect as ConstraintEffect | null)
          : null;
      if (!constraintEffect) {
        findings.push({
          level: "error",
          path: c.path,
          lineageId: c.lineageId,
          code: "constraint_effect",
          message: `${c.path}: ${c.lineageId} is a constraint, and a record file has no field for whether it requires or forbids. Create the constraint in Oxagen, which records its effect.`,
        });
        continue;
      }
    }
    const content: RecordContent = { ...c.content, constraintEffect };
    const renamed = rec !== null && key(rec.slug) !== key(c.lineageId);
    const changed =
      rec === null ||
      rec.deleted ||
      rec.status !== "active" ||
      rec.body === null ||
      contentKeyOf(rec.body) !== c.contentKey;
    if (changed) {
      plan.publish.push({
        recordId: rec?.id ?? null,
        lineageId: c.lineageId,
        path: c.path,
        body: c.body,
        checksum: sha256Hex(c.body),
        content,
      });
    }
    const update: PlannedUpdate = {
      recordId: rec?.id ?? "",
      lineageId: c.lineageId,
    };
    if (rec && renamed) update.slug = c.lineageId;
    if (rec && !changed && rec.path !== c.path) update.path = c.path;
    if (rec && !changed && content.label && content.label !== rec.label)
      update.label = content.label;
    if (
      rec &&
      (update.slug !== undefined ||
        update.path !== undefined ||
        update.label !== undefined)
    )
      plan.update.push(update);
  }

  // Two active constraints on one statement cannot require and forbid it at
  // once. The file being published is the one refused; the record in force
  // stays.
  const inForce = input.records.filter(
    (r) => r.status === "active" && !r.deleted && !retiring.has(r.id),
  );
  plan.publish = plan.publish.filter((p) => {
    if (p.content.kind !== "constraint") return true;
    const clash = [
      ...inForce.filter((r) => r.id !== p.recordId),
      ...plan.publish
        .filter((o) => o !== p)
        .map((o) => ({
          slug: o.lineageId,
          kind: o.content.kind as string | null,
          constraintEffect: o.content.constraintEffect as string | null,
          statement: o.content.statement as string | null,
        })),
    ].find(
      (r) =>
        r.kind === "constraint" &&
        r.constraintEffect !== null &&
        r.constraintEffect !== p.content.constraintEffect &&
        sameStatement(r.statement, p.content.statement),
    );
    if (!clash) return true;
    findings.push({
      level: "error",
      path: p.path,
      lineageId: p.lineageId,
      code: "constraint_conflict",
      message: `${p.path}: ${p.lineageId} would ${p.content.constraintEffect} a statement that ${clash.slug} ${clash.constraintEffect}s. Both cannot hold. Retire one of them first.`,
    });
    return false;
  });

  // A record the repository no longer holds retires. Records written before
  // the repository was the source (no path under `.oxagen/rules/`) are not
  // the sync's, and a record whose file could not be read keeps its version.
  for (const rec of input.records) {
    const k = key(rec.slug);
    if (
      rec.deleted ||
      rec.status !== "active" ||
      !isRepositoryRecord(rec.path) ||
      claimed.has(rec.id) ||
      seen.has(k) ||
      blocked.has(k) ||
      defer.has(k) ||
      unreadable.has(rec.path!)
    )
      continue;
    plan.retire.push({
      recordId: rec.id,
      lineageId: rec.slug,
      reason: "file_removed",
    });
  }
  return plan;
}
