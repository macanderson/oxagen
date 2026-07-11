/**
 * write.ts — Scaffold a new skill for `oxagen skill new`.
 *
 * A skill is a directory, not a flat file, so this can't reuse
 * `scaffoldMarkdownFile` directly: it creates `.oxagen/skills/<name>/SKILL.md`
 * (never overwriting an existing manifest) with the same non-clobbering
 * semantics.
 */
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const TEMPLATE = (name: string) => `---
name: ${name}
description: Describe when this skill should be used (this line is always shown to the agent).
---

# ${name}

Describe the skill: what it does, when to reach for it, and the concrete steps
to follow. This whole body is injected into the agent's system prompt only when
the skill is explicitly selected.
`;

/**
 * Write a starter skill to `.oxagen/skills/<name>/SKILL.md`. Returns the
 * manifest path and whether it was created (false if one already existed).
 */
export function scaffoldSkill(opts: {
  name: string;
  cwd?: string;
  dir?: string;
}): {
  path: string;
  created: boolean;
} {
  const skillsDir =
    opts.dir ?? join(opts.cwd ?? process.cwd(), ".oxagen", "skills");
  const path = join(skillsDir, opts.name, "SKILL.md");
  if (existsSync(path)) return { path, created: false };
  mkdirSync(join(skillsDir, opts.name), { recursive: true });
  writeFileSync(path, TEMPLATE(opts.name), "utf8");
  return { path, created: true };
}
