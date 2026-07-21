/**
 * skill command — manage loadable skills.
 *
 *   oxagen skill list            List available skills (name, description, source)
 *   oxagen skill show <name>     Show a skill's full instructions
 *   oxagen skill new <name>      Scaffold .oxagen/skills/<name>/skill.toml
 *
 * Skills are reference material injected into the agent's system prompt (see
 * skills/loader.ts skillsPromptBlock); this command manages the local ones.
 *
 * Output discipline (ADR-023 §4): the list / skill / scaffold result is the
 * answer and goes to stdout via the writer (so it is REPL-bridge safe) — `--json`
 * emits one single-line JSON value (shape preserved: list → summary array, show →
 * the skill, new → `{name,path,created}`), pretty mode renders the human view.
 * A bad name exits 2 (usage) and an unknown skill exits 1, both as uniform
 * stderr error lines that never touch stdout.
 */
import {
  loadSkills,
  scaffoldSkill,
  type Skill,
  type LoadSkillsOptions,
} from "../skills/index.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export type SkillCmdCtx = Pick<LoadSkillsOptions, "cwd" | "userHomeDir"> & {
  /** `--json`: emit the result as one machine-readable JSON value on stdout (ADR-023 §4). */
  json?: boolean;
};

/** Compact per-skill record for `skill list --json` (body omitted — that's `show`). */
interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source: string;
}

function summarizeSkill(s: Skill): SkillSummary {
  return {
    name: s.name,
    description: s.description,
    path: s.path,
    source: s.source,
  };
}

export function skillList(
  ctx: SkillCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const skills = [...loadSkills(ctx).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  out.data(skills.map(summarizeSkill), () => prettySkillList(skills));
}

export function skillShow(
  name: string,
  ctx: SkillCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const skill = loadSkills(ctx).get(name);
  if (!skill) {
    out.error(
      `Unknown skill "${name}". Run \`oxagen skill list\`.`,
      "not_found",
    );
    return;
  }
  out.data(skill, () => prettySkill(skill));
}

export function skillNew(
  name: string,
  ctx: SkillCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
    // Malformed input → usage error (exit 2). Set before out.error so it wins.
    process.exitCode = 2;
    out.error(
      `Invalid skill name "${name}". Use letters, digits, dashes, underscores.`,
      "usage",
    );
    return;
  }
  const { path, created } = scaffoldSkill({ name, cwd: ctx.cwd });
  // The scaffold outcome IS the command's result → stdout via out.data; the
  // human "created/exists" line lives only in the pretty renderer.
  out.data({ name, path, created }, () =>
    created
      ? `✓ Created skill ${path}\n  Edit it, then list it with: oxagen skill list`
      : `${path} already exists — left untouched.`,
  );
}

function prettySkillList(skills: Skill[]): string {
  if (skills.length === 0) {
    return "No skills defined. Create one with `oxagen skill new <name>`.";
  }
  const lines: string[] = ["Skills:", ""];
  for (const s of skills) {
    lines.push(`  ${s.name}`);
    if (s.description) lines.push(`    ${s.description}`);
    lines.push(`    ${s.path}`);
  }
  return lines.join("\n");
}

function prettySkill(skill: Skill): string {
  const lines: string[] = [`# ${skill.name}`];
  if (skill.description) lines.push(skill.description);
  lines.push("", `source: ${skill.source}`);
  lines.push("", "--- instructions ---", "", skill.body);
  return lines.join("\n");
}
