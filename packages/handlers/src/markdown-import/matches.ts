// markdown-import/matches.ts: the import's duplicates and conflicts. The
// pass lives in @oxagen/steering-check beside the conflicts check it shares
// its test with (import-matches.ts), so the CLI can run it again over the
// rows of several parse calls.
export {
  markImportMatches as markMatches,
  type ImportMatchRow as MatchedRow,
  type ImportPublishedRecord as PublishedRecord,
} from "@oxagen/steering-check";
