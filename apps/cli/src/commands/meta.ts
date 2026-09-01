/**
 * commands/meta.ts — Commander-tree introspection shared by the REPL and the
 * slash-command catalog.
 *
 * Extracted from program.ts so leaf modules (slash/catalog.ts,
 * repl/interactive.tsx) can type/inspect CLI commands WITHOUT importing the
 * whole composition root: program.ts holds the full 2k-line command tree, so
 * importing it from the REPL/slash layer put every command edit in their
 * type-check and test closure. This module is a leaf — it depends only on
 * commander's types and knows nothing about the actual command set.
 */
import type { Command } from "commander";

/** Metadata for one CLI command, surfaced in the REPL slash-command menu. */
export interface CliCommandMeta {
  /** Command name as typed (e.g. "graph", "cost"). */
  name: string;
  /** One-line description (the same string `--help` prints). */
  description: string;
  /** Argument hint derived from the command's declared arguments, e.g. "<query> [focus]". */
  argumentHint?: string;
}

/** Join a command path the same way everywhere — the REPL dispatcher (see
 * repl/cli-bridge.ts) splits back on ":" to recover the path segments. */
export function joinCliCommandPath(pathParts: readonly string[]): string {
  return pathParts.join(":");
}

/**
 * Read every command's name + description + argument shape straight from the
 * Commander tree — top-level AND every nested subcommand (`graph search`,
 * `mcp add`, `secret set`, …), walked recursively. This is what makes the
 * slash menu and `--help` stay in lockstep: there is no second list to drift.
 *
 * A subcommand's catalog `name` is its full path colon-joined (e.g.
 * "graph:search") so it is a single unambiguous token the REPL can parse with
 * a plain `parseInvocation` (which only splits on the first whitespace) —
 * `/graph:search -q foo` unambiguously names the "graph search" leaf command
 * with `-q foo` as its arguments. Top-level commands are unaffected (a
 * one-segment path colon-joins to itself), so every existing catalog entry
 * keeps its exact former name.
 */
export function describeCliCommands(program: Command): CliCommandMeta[] {
  const out: CliCommandMeta[] = [];
  const walk = (cmd: Command, parentPath: readonly string[]): void => {
    const path = [...parentPath, cmd.name()];
    const hint = cmd.registeredArguments
      .map((arg) => (arg.required ? `<${arg.name()}>` : `[${arg.name()}]`))
      .join(" ");
    out.push({
      name: joinCliCommandPath(path),
      description: cmd.description(),
      argumentHint: hint || undefined,
    });
    for (const sub of cmd.commands) walk(sub, path);
  };
  for (const cmd of program.commands) walk(cmd, []);
  return out;
}
