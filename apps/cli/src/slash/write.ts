/**
 * write.ts — Scaffold a new slash command for `oxagen command new`.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const TEMPLATE = (name: string) => `---
description: Describe what /${name} does.
argument-hint: <arg>
---

You are running the /${name} command with arguments: $ARGUMENTS

Replace this body with the prompt this command should send. Use $ARGUMENTS for
all arguments, or $1, $2, … for positional ones.
`;

/** Write a starter slash command to `.oxagen/commands/<name>.md`. */
export function scaffoldCommand(opts: { name: string; cwd?: string; dir?: string }): {
  path: string;
  created: boolean;
} {
  const dir = opts.dir ?? join(opts.cwd ?? process.cwd(), ".oxagen", "commands");
  const path = join(dir, `${opts.name}.md`);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, TEMPLATE(opts.name), "utf8");
  return { path, created: true };
}
