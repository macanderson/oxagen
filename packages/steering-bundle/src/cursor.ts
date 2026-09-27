// cursor.ts: how Cursor reads steering (steering-repo-spec, Cursor).
//
// Cursor's model calls go to Cursor's servers, so no always-on block reaches
// its requests, and a code repository holds no committed Oxagen files. Cursor
// reads steering through Oxagen's MCP server instead: steering_search finds
// the records a task needs, and steering_read returns each body. One rule in
// Cursor's dashboard tells it to do that. A workspace admin adds it once:
//   1. Open Cursor's dashboard, then Rules.
//   2. Add a team rule, set it to always apply, and paste
//      CURSOR_DASHBOARD_RULE as its text.
// The Oxagen MCP server must be connected in Cursor for the two tools to exist.

/** The rule a workspace admin adds in Cursor's dashboard. */
export const CURSOR_DASHBOARD_RULE = [
  "Steering from Oxagen",
  "",
  "At the start of each task, call the Oxagen MCP tool steering_search with the task's repository, such as github.com/a-intel/platform, and limit 50.",
  "When total is larger than the hits returned, search again with words from the task.",
  "Call steering_read for every hit whose always_on is true, and follow those records for the whole task.",
  "Read any other hit whose line fits the task before you act on it.",
  "When a record mentions @record:<lineage> or @skill:<lineage>, read it with steering_read.",
  "A record with force must is a requirement. A record with force should is the default unless the task gives a reason.",
].join("\n");
