/**
 * write.ts — Scaffold a new slash command for `oxagen command new`.
 */
import { scaffoldMarkdownFile } from "../lib/markdown-registry.js";
import { oxagenProjectDir } from "../lib/oxagen-project-paths.js";

const TEMPLATE = (name: string) => `---
description: Describe what /${name} does.
argument-hint: <arg>
---

You are running the /${name} command with arguments: $ARGUMENTS

Replace this body with the prompt this command should send. Use $ARGUMENTS for
all arguments, or $1, $2, … for positional ones.
`;

/** Write a starter slash command to `.oxagen/commands/<name>.md`. */
export function scaffoldCommand(opts: {
  name: string;
  cwd?: string;
  dir?: string;
}): {
  path: string;
  created: boolean;
} {
  const dir = opts.dir ?? oxagenProjectDir("commands", opts.cwd);
  return scaffoldMarkdownFile({ dir, name: opts.name, template: TEMPLATE });
}
