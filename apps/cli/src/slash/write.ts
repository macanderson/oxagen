/**
 * write.ts — Scaffold a new slash command for `oxagen command new`.
 */
import { join } from "node:path";
import { scaffoldMarkdownFile } from "../lib/markdown-registry.js";

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
  const dir =
    opts.dir ?? join(opts.cwd ?? process.cwd(), ".oxagen", "commands");
  return scaffoldMarkdownFile({ dir, name: opts.name, template: TEMPLATE });
}
