// The statement grid's rows (memory-collection spec, Bulk import and
// Enforcement grade; the mockup's md-import.js, `mdimRows`, `mdimGoes`,
// `mdimOpen` and `ACTS["mdim-go"]`): what parse_markdown_import proposed for
// each statement, what a person changed on it, and the rows
// commit_markdown_import takes back.
//
// A row's force always sits inside the forces its kind allows. The rule is
// `forcesFor` in @oxagen/oxagen/steering-repo/record-force, the one the
// import contracts enforce and the record wizard reads, so a kind changed
// here can never carry a force the commit refuses.
//
// A conflict waits for a choice. Keep the record leaves the statement out.
// Replace the record lets the statement win: over a published record it takes
// that record's lineage, so the commit writes over the record where it lives,
// and over an earlier statement of the same import it leaves that statement
// out. Until a person chooses, the row blocks the steering PR.
import type { steeringMarkdownImportParse } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import {
  clampForce,
  forcesFor,
} from "@oxagen/oxagen/steering-repo/record-force";
import { RECORD_KINDS } from "@oxagen/oxagen/steering-repo/record-kind";
import type { ContractOutput } from "@/server/kernel";
import { type ImportTarget, PARSE_CALL_BYTES_MAX } from "./files";

export type ParseOutput = ContractOutput<typeof steeringMarkdownImportParse>;
export type ImportRecord = ParseOutput["records"][number];
export type ImportPolicy = ParseOutput["policies"][number];
export type ImportFileResult = ParseOutput["files"][number];
/**
 * The kinds and effects as plain unions, not as the contract's zod output, so
 * a message key built from one (`kinds.${kind}`) expands to its literals.
 */
export type ImportKind = (typeof RECORD_KINDS)[number];
export type ImportEffect = "require" | "forbid";
export type ImportForce = ImportRecord["force"];
export type ImportAction = ImportRecord["action"];

/** The eight record kinds, in the order the Kind select offers them. */
export const IMPORT_KINDS: readonly ImportKind[] = RECORD_KINDS;

/** Every parse call's answer, joined in the order the calls went. */
export type ParseResult = {
  files: ImportFileResult[];
  records: ImportRecord[];
  policies: ImportPolicy[];
  /** The most files one steering PR holds. */
  max: number;
};

/**
 * Join the answers of the parse calls one import made. Each call compared
 * only its own files, so a duplicate or a conflict between two calls is left
 * for the steering PR's conflicts check, and two rows given one lineage are
 * refused by the commit, which names both.
 */
export function mergeParses(outputs: readonly ParseOutput[]): ParseResult {
  return {
    files: outputs.flatMap((o) => o.files),
    records: outputs.flatMap((o) => o.records),
    policies: outputs.flatMap((o) => o.policies),
    max: outputs[0]?.pullRequestFiles.max ?? 0,
  };
}

/** What a person changed on one row. */
export type RowEdit = {
  /** The Import checkbox. */
  on: boolean;
  /** How a conflict is settled, or null while nobody chose. */
  choice: "keep" | "replace" | null;
  kind: ImportKind;
  force: ImportForce;
  effect: ImportEffect | null;
  /** True once a person picked the force, rather than the kind giving it. */
  forceChosen: boolean;
};

/**
 * A row's key: its file, line, lineage, and words. A second parse of the same
 * files that proposes the same statement finds the edit made on it.
 */
export function rowKey(record: ImportRecord): string {
  return [record.file, record.line, record.lineage, record.statement].join(
    "\u0000",
  );
}

/** A row as parse proposed it: a duplicate starts unticked, a conflict ticked with no choice. */
export function initialEdit(record: ImportRecord): RowEdit {
  return {
    on: record.action !== "skip",
    choice: null,
    kind: record.kind,
    force: record.force,
    effect: record.effect,
    forceChosen: false,
  };
}

export function editOf(
  edits: ReadonlyMap<string, RowEdit>,
  record: ImportRecord,
): RowEdit {
  return edits.get(rowKey(record)) ?? initialEdit(record);
}

const RANK: Record<ImportForce, number> = { must: 3, should: 2, may: 1, info: 0 };

/**
 * The force the words behind it point to (memory-collection spec,
 * Enforcement grade): must, never, always, and do not point to must, should
 * and prefer to point to should, and consider and can point to may.
 */
export function wordForce(words: string): ImportForce | null {
  if (/\b(must|never|always|do not|don't|no agent)\b/i.test(words))
    return "must";
  if (/\b(should|prefer)\b/i.test(words)) return "should";
  if (/\b(consider|can)\b/i.test(words)) return "may";
  return null;
}

/** The forces a row of this kind may carry, strongest first. */
export function forcesOf(kind: ImportKind): readonly ImportForce[] {
  return forcesFor(kind);
}

/**
 * The force a kind gives a row. Its own kind keeps the force parse proposed.
 * Another kind takes the force the words point to when the kind allows it,
 * and the kind's default when it does not or when no word points anywhere.
 */
export function forceForKind(
  record: ImportRecord,
  kind: ImportKind,
): ImportForce {
  if (kind === record.kind) return record.force;
  return clampForce(kind, wordForce(record.forceWords));
}

const FORBIDS = /\b(never|must not|do not|don't|no agent)\b/i;

/**
 * A new kind for a row. The force narrows to the forces the kind allows, and a
 * constraint gets the effect the statement points to. A frontmatter record
 * keeps the kind its file declares.
 */
export function changeKind(
  record: ImportRecord,
  edit: RowEdit,
  kind: ImportKind,
): RowEdit {
  if (record.origin === "frontmatter") return edit;
  const effect =
    kind === "constraint"
      ? (edit.effect ??
        record.effect ??
        (FORBIDS.test(record.statement) ? "forbid" : "require"))
      : null;
  return {
    ...edit,
    kind,
    force: forceForKind(record, kind),
    effect,
    forceChosen: false,
  };
}

/** A force a person picked, when the row's kind allows it. */
export function changeForce(edit: RowEdit, force: ImportForce): RowEdit {
  if (!forcesFor(edit.kind).includes(force)) return edit;
  return { ...edit, force, forceChosen: true };
}

/** A constraint's effect. Any other kind carries none. */
export function changeEffect(edit: RowEdit, effect: ImportEffect): RowEdit {
  return edit.kind === "constraint" ? { ...edit, effect } : edit;
}

/** Why a row has its force, for the line under its words. */
export type ForceReason = "chosen" | "only" | "points" | "capped" | "default";

export function forceReason(record: ImportRecord, edit: RowEdit): ForceReason {
  if (edit.forceChosen) return "chosen";
  if (forcesFor(edit.kind).length === 1) return "only";
  if (record.forceWords.trim() === "") return "default";
  const pointed = wordForce(record.forceWords);
  return pointed !== null && RANK[pointed] > RANK[edit.force]
    ? "capped"
    : "points";
}

/** One row with what the commit does with it. */
export type ResolvedRow = {
  record: ImportRecord;
  edit: RowEdit;
  /** add or skip, or null while a conflict waits for a choice. */
  action: ImportAction;
  /** The lineage the commit writes: the row's own, or the published record it replaces. */
  lineage: string;
  /** The index of the row whose Replace the record leaves this one out, or null. */
  replacedBy: number | null;
};

function ownAction(record: ImportRecord, edit: RowEdit): ImportAction {
  if (!edit.on) return "skip";
  if (record.conflict === null) return "add";
  if (edit.choice === null) return null;
  return edit.choice === "keep" ? "skip" : "add";
}

/** Every row with its action, after each conflict's choice is applied. */
export function resolveRows(
  records: readonly ImportRecord[],
  edits: ReadonlyMap<string, RowEdit>,
): ResolvedRow[] {
  const rows: ResolvedRow[] = records.map((record) => {
    const edit = editOf(edits, record);
    return {
      record,
      edit,
      action: ownAction(record, edit),
      lineage: record.lineage,
      replacedBy: null,
    };
  });
  rows.forEach((row, index) => {
    const conflict = row.record.conflict;
    if (conflict === null || row.action !== "add") return;
    if (conflict.published) {
      row.lineage = conflict.lineage;
      return;
    }
    const other = rows.findIndex(
      (o, at) => at !== index && o.record.lineage === conflict.lineage,
    );
    const beaten = rows[other];
    if (beaten !== undefined) {
      beaten.action = "skip";
      beaten.replacedBy = index;
    }
  });
  return rows;
}

/** What the grid's foot counts. */
export type Tally = {
  /** Records the steering PR would hold. */
  records: number;
  /** Policy files the steering PR would hold. */
  policies: number;
  /** Statements left out. */
  out: number;
  /** Conflicts that still need a choice. */
  open: number;
  /** The tokens the must and should rows add to every request. */
  tokens: number;
};

export function tally(
  rows: readonly ResolvedRow[],
  policies: readonly ImportPolicy[],
): Tally {
  let records = 0;
  let out = 0;
  let open = 0;
  let tokens = 0;
  for (const row of rows) {
    if (row.action === null) open += 1;
    else if (row.action === "skip") out += 1;
    else {
      records += 1;
      if (row.edit.force === "must" || row.edit.force === "should")
        tokens += row.record.tokens;
    }
  }
  return {
    records,
    policies: policies.filter((p) => p.action === "add").length,
    out,
    open,
    tokens,
  };
}

/** The rows commit_markdown_import takes: each as parse proposed it, with the person's changes. */
export function commitRecords(rows: readonly ResolvedRow[]): ImportRecord[] {
  return rows.map(({ record, edit, action, lineage }) => ({
    ...record,
    lineage,
    kind: edit.kind,
    force: edit.force,
    effect: edit.kind === "constraint" ? edit.effect : null,
    action,
  }));
}

export type CommitPayload = {
  records: ImportRecord[];
  policies: ImportPolicy[];
};

function bytesOf(payload: CommitPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/**
 * What the commit sends. Every row goes, so the PR body counts the rows left
 * out. When that is more than one server action carries, the rows marked
 * skip stay behind, since they write no file. Null when the rows marked add
 * alone are too large.
 */
export function commitPayload(
  rows: readonly ResolvedRow[],
  policies: readonly ImportPolicy[],
  bytesMax: number = PARSE_CALL_BYTES_MAX,
): CommitPayload | null {
  const full: CommitPayload = {
    records: commitRecords(rows),
    policies: [...policies],
  };
  if (bytesOf(full) <= bytesMax) return full;
  const lean: CommitPayload = {
    records: full.records.filter((r) => r.action === "add"),
    policies: full.policies.filter((p) => p.action === "add"),
  };
  return bytesOf(lean) <= bytesMax ? lean : null;
}

/** One file of the grid: its head, and its rows or its policy. */
export type FileGroup = {
  file: string;
  target: ImportTarget;
  result: ImportFileResult;
  rows: { index: number; row: ResolvedRow }[];
  policy: ImportPolicy | null;
};

/** The grid's groups, one per file parse read, in the order the files went. */
export function groupsOf(
  parsed: ParseResult,
  rows: readonly ResolvedRow[],
): FileGroup[] {
  return parsed.files.map((result) => ({
    file: result.filename,
    target: result.target,
    result,
    rows: rows.flatMap((row, index) =>
      row.record.file === result.filename ? [{ index, row }] : [],
    ),
    policy: parsed.policies.find((p) => p.file === result.filename) ?? null,
  }));
}
