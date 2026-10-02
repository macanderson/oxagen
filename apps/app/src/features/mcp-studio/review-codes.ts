// The Review refusals Studio explains in its own words (#4678, item 6), read
// by the Changes tab and by Add server's From a definition, which both open a
// steering PR through open_studio_review. Their text lives under
// mcpStudio.changes.pr.codes. Any other code shows as itself, so a refusal
// this list has not caught up with still names its reason.
const REVIEW_CODES = [
  "denied",
  "invalid",
  "unavailable",
  "pending_approval",
  "exhausted",
  "too_large",
  "draft_not_found",
  "draft_unchanged",
  "draft_unreadable",
  "server_not_found",
  "server_toml_missing",
  "server_toml_invalid",
  "server_name_mismatch",
  "workspace_repository_missing",
  "production_branch_missing",
  "folder_invalid",
  "source_required",
  "source_invalid",
  "source_commit_missing",
  "definition_path_invalid",
  "importer_not_built",
  "tools_unclassified",
  "tool_not_found",
  "tool_not_offered",
  "tool_key_collision",
  "test_invalid",
  "test_holds_credential",
  "tool_paging_missing",
] as const;

type ReviewCode = (typeof REVIEW_CODES)[number];

/** Whether Studio has its own words for a Review refusal. */
export function isReviewCode(code: string): code is ReviewCode {
  return REVIEW_CODES.some((known) => known === code);
}
