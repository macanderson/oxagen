// markdown-import/matches.ts: the duplicates and conflicts an import brings
// (memory-collection spec, Bulk import: Duplicates and conflicts).
//
// Each statement is compared with the published records and with the
// import's other statements by the steering check's own test
// (`similarStatements` in @oxagen/steering-check), so a row this marks is a
// row the steering PR's conflicts check would fail, and a row it leaves alone
// passes there.
//
// - Two constraints on the same statement with opposite effects conflict. A
//   conflict waits for a person's choice: its action is null.
// - Any other match is a duplicate. A duplicate defaults to skip and names
//   the record it matches.
// - Between two rows of the import, the later row is marked against the
//   earlier one.
// - A row whose lineage is already published revises that record, so it is
//   compared with everything but its own published version, as the steering
//   check compares it. When it says what its published version says, it is a
//   duplicate of it: the PR would change nothing. When it turns a published
//   constraint's effect around, it conflicts with it, as the check's
//   effect-flip rule says.
import type { MarkdownImportMatch } from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { similarStatements } from "@oxagen/steering-check";

/** A published record the import compares against. */
export interface PublishedRecord {
  lineage: string;
  kind: string;
  effect: string | null;
  statement: string;
  /** Where the record lives in the steering repo, or null when Oxagen does not know. */
  path: string | null;
}

/** What a row brings to the comparison, and what the comparison writes back. */
export interface MatchedRow {
  lineage: string;
  kind: string;
  effect: string | null;
  statement: string;
  /** Where the commit would write the row. */
  path: string;
  duplicate: MarkdownImportMatch | null;
  conflict: MarkdownImportMatch | null;
}

type Entry =
  | {
      lineage: string;
      kind: string;
      effect: string | null;
      statement: string;
      from: "published";
      record: PublishedRecord;
    }
  | {
      lineage: string;
      kind: string;
      effect: string | null;
      statement: string;
      from: "row";
      index: number;
    };

/**
 * Mark each row's duplicate and conflict in place. A published record a row
 * revises (the same lineage) is left out of the pairwise comparison, because
 * the import writes over it. Each row keeps the first duplicate and the first
 * conflict found for it.
 */
export function markMatches(
  rows: MatchedRow[],
  published: readonly PublishedRecord[],
): void {
  const replaced = new Set(rows.map((row) => row.lineage));
  // A revision that says what its published version says changes nothing. A
  // revision that turns a published constraint's effect around fails the
  // steering check's effect-flip rule, so it is a conflict.
  const byLineage = new Map(published.map((record) => [record.lineage, record]));
  for (const row of rows) {
    const held = byLineage.get(row.lineage);
    if (held === undefined) continue;
    const self = { lineage: held.lineage, path: held.path, published: true };
    const flipped =
      held.kind === "constraint" &&
      row.kind === "constraint" &&
      held.effect !== null &&
      row.effect !== null &&
      held.effect !== row.effect;
    if (flipped) row.conflict = self;
    else if (similarStatements([row, held]).length > 0) row.duplicate = self;
  }
  const entries: Entry[] = [
    ...published
      .filter((record) => !replaced.has(record.lineage))
      .map(
        (record): Entry => ({
          lineage: record.lineage,
          kind: record.kind,
          effect: record.effect,
          statement: record.statement,
          from: "published",
          record,
        }),
      ),
    ...rows.map(
      (row, index): Entry => ({
        lineage: row.lineage,
        kind: row.kind,
        effect: row.effect,
        statement: row.statement,
        from: "row",
        index,
      }),
    ),
  ];
  for (const { a, b, opposite } of similarStatements(entries)) {
    if (a.from === "published" && b.from === "published") continue;
    let target: number;
    let match: MarkdownImportMatch;
    if (a.from === "published" || b.from === "published") {
      const record = (a.from === "published" ? a : b) as Extract<Entry, { from: "published" }>;
      const row = (a.from === "row" ? a : b) as Extract<Entry, { from: "row" }>;
      target = row.index;
      match = { lineage: record.lineage, path: record.record.path, published: true };
    } else {
      const first = a.index < b.index ? a : b;
      const later = a.index < b.index ? b : a;
      target = later.index;
      match = {
        lineage: first.lineage,
        path: (rows[first.index] as MatchedRow).path,
        published: false,
      };
    }
    const row = rows[target] as MatchedRow;
    if (opposite) row.conflict ??= match;
    else row.duplicate ??= match;
  }
}
