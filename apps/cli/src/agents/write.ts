/**
 * write.ts — Scaffold a new agent definition file for `oxagen agent new`.
 */
import { join } from "node:path";
import { scaffoldMarkdownFile } from "../lib/markdown-registry.js";
import { DEFAULT_CODING_MODEL } from "../agent/model-catalog.js";

const TEMPLATE = (name: string) => `---
name: ${name}
description: Describe when this agent should be used (the planner reads this).
tools: Read, Grep, Glob, Bash
model: ${DEFAULT_CODING_MODEL}
# skills: reviewer, deploy         # skill names to pre-load (see \`oxagen skill list\`)
# mcpServers: github, linear       # keys into settings.json \`mcpServers\`
---

You are the ${name} agent.

Describe the agent's role, what it should focus on, and how it should behave.
This whole body becomes the agent's system prompt.
`;

/** Write a starter agent markdown file to `.oxagen/agents/<name>.md`. */
export function scaffoldAgent(opts: {
  name: string;
  cwd?: string;
  dir?: string;
}): {
  path: string;
  created: boolean;
} {
  const dir = opts.dir ?? join(opts.cwd ?? process.cwd(), ".oxagen", "agents");
  return scaffoldMarkdownFile({ dir, name: opts.name, template: TEMPLATE });
}
