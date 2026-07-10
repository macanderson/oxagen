/**
 * write.ts — Scaffold a new rule for `oxagen rules new`.
 */
import { join } from "node:path";
import { scaffoldMarkdownFile } from "../lib/markdown-registry.js";

const TEMPLATE = (name: string) => `---
description: One-line description of what ${name} enforces.
# Optional hard guard — a violating tool call is blocked before it runs.
# guard-tool: Edit        # Bash | Write | Edit | Read | *
# guard-deny-path: packages/database/migrations/*-applied/**
# guard-deny-command: rm -rf*
---

State the rule as one clear, imperative instruction. This text is injected into
the agent's system prompt and returned to the model when a guarded violation is
blocked, so write it so the agent knows what to do instead.
`;

/** Write a starter rule to `.oxagen/rules/<name>.md`. */
export function scaffoldRule(opts: {
  name: string;
  cwd?: string;
  dir?: string;
}): {
  path: string;
  created: boolean;
} {
  const dir = opts.dir ?? join(opts.cwd ?? process.cwd(), ".oxagen", "rules");
  return scaffoldMarkdownFile({ dir, name: opts.name, template: TEMPLATE });
}
