// The duplicates and conflicts between the parse calls of one Markdown import
// (memory-collection spec, Bulk import: Duplicates and conflicts). Each
// parse_markdown_import call compares only its own files, so an import sent
// in several calls runs the steering check's own pass once more over every
// call's rows, as `oxagen steering import` does
// (apps/cli/src/lib/markdown-import.ts). Without it, a statement that repeats
// one from another call reaches the steering PR, and the PR's conflicts
// check fails a valid import.
//
// Server only: ./actions.ts is the one importer. @oxagen/steering-check's
// barrel carries every steering check and a TOML reader, which the browser
// bundle has no use for, and the kernel's handlers already bring it into the
// server bundle.
import { markImportMatches } from "@oxagen/steering-check";
import type { MatchRow, RowMarks } from "./rows";

/**
 * Every row's marks once the rows of all the calls are compared with each
 * other. A row keeps each mark its own call gave it, and a later row is
 * marked against an earlier one. The published records were compared by each
 * call already, so none is passed here.
 */
export function marksAcrossCalls(rows: readonly MatchRow[]): RowMarks[] {
  const marked = rows.map((row) => ({ ...row, path: null }));
  markImportMatches(marked, []);
  return marked.map(({ duplicate, conflict }) => ({ duplicate, conflict }));
}
