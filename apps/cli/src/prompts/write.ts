/**
 * write.ts — Scaffold a new saved prompt for `oxagen prompt new`.
 */
import { join } from "node:path";
import { scaffoldMarkdownFile } from "../lib/markdown-registry.js";

const TEMPLATE = (name: string) => `---
description: Describe what the ${name} prompt is for.
argument-hint: <arg>
---

Replace this body with the prompt text you want to save under "${name}".
Recall it with: oxagen prompt show ${name}
`;

/** Write a starter saved prompt to `.oxagen/prompts/<name>.md`. */
export function scaffoldPrompt(opts: {
  name: string;
  cwd?: string;
  dir?: string;
}): {
  path: string;
  created: boolean;
} {
  const dir = opts.dir ?? join(opts.cwd ?? process.cwd(), ".oxagen", "prompts");
  return scaffoldMarkdownFile({ dir, name: opts.name, template: TEMPLATE });
}
