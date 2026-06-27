/**
 * write.ts — Scaffold a new agent definition file for `oxagen agent new`.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const TEMPLATE = (name: string) => `---
name: ${name}
description: Describe when this agent should be used (the planner reads this).
tools: Read, Grep, Glob, Bash
model: anthropic/claude-sonnet-4.6
---

You are the ${name} agent.

Describe the agent's role, what it should focus on, and how it should behave.
This whole body becomes the agent's system prompt.
`;

/** Write a starter agent markdown file to `.oxagen/agents/<name>.md`. */
export function scaffoldAgent(opts: { name: string; cwd?: string; dir?: string }): {
  path: string;
  created: boolean;
} {
  const dir = opts.dir ?? join(opts.cwd ?? process.cwd(), ".oxagen", "agents");
  const path = join(dir, `${opts.name}.md`);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, TEMPLATE(opts.name), "utf8");
  return { path, created: true };
}
