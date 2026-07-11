/**
 * @module prompts — Saved prompts for the CLI.
 *
 * Named, describable prompt snippets loaded from markdown under
 * `.oxagen/prompts/<name>.md` (or `.claude/prompts`, `~/.config/oxagen/prompts`),
 * recalled with `oxagen prompt list|show <name>`.
 */
export type { SavedPrompt } from "./types.js";
export { loadPrompts, getPrompt, type LoadPromptsOptions } from "./loader.js";
export { scaffoldPrompt } from "./write.js";
