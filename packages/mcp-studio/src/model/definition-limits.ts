// definition-limits.ts: the size limit every definition import shares
// (mcp-studio-spec, Definition import).

/** Import refuses a definition over 25 MB: one file, or all of a multi-file document together. */
export const DEFINITION_BYTES_MAX = 25 * 1024 * 1024;
