/**
 * @module slash — User-defined slash commands for the CLI.
 *
 * Reusable prompt templates invoked as `/name args` in the REPL or via
 * `oxagen command run name args`, loaded from canonical TOML artifacts.
 */
export type { SlashCommand } from "./types.js";
export { loadCommands, type LoadCommandsOptions } from "./loader.js";
export {
  expandSlash,
  loadAndExpand,
  parseInvocation,
  applyArgs,
  type SlashExpansion,
  type SlashError,
} from "./expand.js";
export { scaffoldCommand } from "./write.js";
