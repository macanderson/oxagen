// tokens.ts: the one token estimator every steering budget uses, and the
// budgets and limits the spec sets (steering-repo-spec, Token efficiency,
// File formats, Scale, and Memory). Imports nothing.

/**
 * UTF-8 bytes in a string, counted without an encoder. A lone surrogate counts
 * three bytes, the size of the replacement character an encoder writes for it.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Tokens in a text: `ceil(utf8_bytes / 4)`. Every budget counts with this
 * one function: the `budget` check, delivery, and MCP Studio's definition
 * totals. It is the unit the steering assembler, the host bundle, and the
 * Context Graph Protocol's `budgetTokens` already count in, so a figure here
 * agrees with the figures those report.
 */
export function countTokens(text: string): number {
  return Math.ceil(utf8Length(text) / 4);
}

// ── Budgets ──────────────────────────────────────────────────────────────────

/** Oxagen's always-on budget per code repository, when governance.toml sets none. */
export const DEFAULT_ALWAYS_ON_TOKENS = 4000;
/** The workspace's direct-mode definition budget, when `[tools] definition_budget` is unset. */
export const DEFAULT_WORKSPACE_DEFINITION_BUDGET = 20000;
/** One server's definition budget, when its server.toml sets none. */
export const DEFAULT_SERVER_DEFINITION_BUDGET = 8000;

// ── Limits the checks warn about ─────────────────────────────────────────────

/** The `schema` check warns when an always-on body passes this many words. */
export const ALWAYS_ON_BODY_WORDS_WARN = 120;
/** The `schema` check warns when a SKILL.md passes this many lines. */
export const SKILL_LINES_WARN = 500;
/** The `schema` check warns when one folder holds more files than this. */
export const FOLDER_FILES_WARN = 800;
/** GitHub and GitLab truncate a folder's web view at this many entries. */
export const FOLDER_FILES_MAX = 1000;

// ── Size limits ──────────────────────────────────────────────────────────────

/** A record or a TOML file, in bytes. */
export const RECORD_BYTES_MAX = 256 * 1024;
/** One asset in a skill folder, in bytes. */
export const SKILL_ASSET_BYTES_MAX = 1024 * 1024;
/** An OpenAPI document, in bytes. */
export const OPENAPI_BYTES_MAX = 25 * 1024 * 1024;

// ── Record fields ────────────────────────────────────────────────────────────

/** The longest `description` on any kind but a skill. */
export const DESCRIPTION_MAX = 200;
/** The longest `description` on a skill. */
export const SKILL_DESCRIPTION_MAX = 1024;

// ── Memory ───────────────────────────────────────────────────────────────────

/** The most memories the gateway adds to one request. */
export const MEMORY_RECALL_MAX = 5;
/** The most tokens those memories may take together. */
export const MEMORY_RECALL_TOKENS_MAX = 800;
