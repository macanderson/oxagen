/**
 * expand.ts — Turn a `/name args` invocation into a concrete prompt.
 *
 * Substitution in the template:
 *   - $ARGUMENTS   the full argument string
 *   - $1 … $9      positional arguments (whitespace-split); missing → ""
 *
 * Returns the expanded prompt (and any model override), an error, or null when
 * the input does not name a known command (so the REPL can say "unknown").
 */
import { loadCommands, type LoadCommandsOptions } from "./loader.js";
import type { SlashCommand } from "./types.js";

export interface SlashExpansion {
  command: string;
  prompt: string;
  model?: string;
}

export interface SlashError {
  error: string;
}

/** Parse "/review src/x here" → { name: "review", args: "src/x here" }. */
export function parseInvocation(
  input: string,
): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const space = rest.search(/\s/);
  if (space === -1) return { name: rest, args: "" };
  return { name: rest.slice(0, space), args: rest.slice(space + 1).trim() };
}

/**
 * Apply $ARGUMENTS / $1..$9 substitution to a template.
 *
 * Two properties matter, both handled by a SINGLE function-replacement pass:
 *
 *   1. Args are inserted verbatim. `String.prototype.replace(pattern, string)`
 *      interprets `$&`, `$'`, `` $` `` and `$1` in the replacement *string* as
 *      special patterns, so user args containing those sequences would be
 *      corrupted (e.g. a commit message `fix $& regex`). A function replacement
 *      is treated literally — args land exactly as typed.
 *   2. Args are inserted ONCE, never re-scanned. Running two sequential
 *      `.replace` passes (`$ARGUMENTS` then `$1..$9`) meant a literal `$1`
 *      *inside* the user's args — freshly inserted by the first pass — got
 *      expanded by the second pass into the first positional. Matching both
 *      placeholders in one pass over the ORIGINAL template closes that hole:
 *      inserted text is part of the output, never a match target.
 */
export function applyArgs(template: string, args: string): string {
  const positionals = args.length > 0 ? args.split(/\s+/) : [];
  return template.replace(
    /\$ARGUMENTS\b|\$([1-9])\b/g,
    (_match, digit?: string) =>
      digit === undefined ? args : (positionals[Number(digit) - 1] ?? ""),
  );
}

/** Expand against an already-loaded registry. Returns null if name is unknown. */
export function expandSlash(
  input: string,
  registry: Map<string, SlashCommand>,
): SlashExpansion | SlashError | null {
  const parsed = parseInvocation(input);
  if (!parsed) return { error: "not a slash command" };
  const command = registry.get(parsed.name);
  if (!command) return null;
  return {
    command: command.name,
    prompt: applyArgs(command.template, parsed.args),
    model: command.model,
  };
}

/** Load the registry and expand in one call (REPL convenience). */
export function loadAndExpand(
  input: string,
  opts: LoadCommandsOptions = {},
): SlashExpansion | SlashError | null {
  return expandSlash(input, loadCommands(opts));
}
