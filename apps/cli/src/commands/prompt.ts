/**
 * prompt — manage saved prompts.
 *
 *   oxagen prompt list                List saved prompts
 *   oxagen prompt show <name>         Show a saved prompt's text
 *   oxagen prompt new <name>          Scaffold .oxagen/prompts/<name>.md
 *
 * Saved prompts are reusable prompt snippets — unlike slash commands they are
 * not executed; they are recalled and fed into a turn by hand.
 *
 * Output discipline (ADR-023 §4): the list / prompt / scaffold result is the
 * answer and goes to stdout via the writer (so it is REPL-bridge safe) — `--json`
 * emits one single-line JSON value (shape preserved: list → summary array, show →
 * the prompt, new → `{name,path,created}`), pretty mode renders the human view.
 * A bad name exits 2 (usage) and an unknown prompt exits 1, both as uniform
 * stderr error lines that never touch stdout.
 */
import {
  loadPrompts,
  scaffoldPrompt,
  type SavedPrompt,
  type LoadPromptsOptions,
} from "../prompts/index.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export type PromptCmdCtx = Pick<
  LoadPromptsOptions,
  "cwd" | "userPromptsDir"
> & {
  /** `--json`: emit the result as one machine-readable JSON value on stdout (ADR-023 §4). */
  json?: boolean;
};

/** Compact per-prompt record for `prompt list --json` (body omitted — that's `show`). */
interface PromptSummary {
  name: string;
  description: string;
  argumentHint: string | null;
  source: string;
}

function summarizePrompt(p: SavedPrompt): PromptSummary {
  return {
    name: p.name,
    description: p.description,
    argumentHint: p.argumentHint ?? null,
    source: p.source,
  };
}

export function promptList(
  ctx: PromptCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const prompts = [...loadPrompts(ctx).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  out.data(prompts.map(summarizePrompt), () => prettyPromptList(prompts));
}

export function promptShow(
  name: string,
  ctx: PromptCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const prompt = loadPrompts(ctx).get(name);
  if (!prompt) {
    out.error(
      `Unknown prompt "${name}". Run \`oxagen prompt list\`.`,
      "not_found",
    );
    return;
  }
  out.data(prompt, () => prettyPrompt(prompt));
}

export function promptNew(
  name: string,
  ctx: PromptCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
    // Malformed input → usage error (exit 2). Set before out.error so it wins.
    process.exitCode = 2;
    out.error(
      `Invalid prompt name "${name}". Use letters, digits, dashes, underscores.`,
      "usage",
    );
    return;
  }
  const { path, created } = scaffoldPrompt({ name, cwd: ctx.cwd });
  // The scaffold outcome IS the command's result → stdout via out.data; the
  // human "created/exists" line lives only in the pretty renderer.
  out.data({ name, path, created }, () =>
    created
      ? `✓ Created prompt ${path}\n  Edit it, then recall it with: oxagen prompt show ${name}`
      : `${path} already exists — left untouched.`,
  );
}

function prettyPromptList(prompts: SavedPrompt[]): string {
  if (prompts.length === 0) {
    return "No saved prompts. Create one with `oxagen prompt new <name>`.";
  }
  const lines: string[] = ["Saved prompts:", ""];
  for (const p of prompts) {
    lines.push(`  ${p.name}${p.argumentHint ? ` ${p.argumentHint}` : ""}`);
    if (p.description) lines.push(`    ${p.description}`);
  }
  return lines.join("\n");
}

function prettyPrompt(prompt: SavedPrompt): string {
  const lines: string[] = [`# ${prompt.name}`];
  if (prompt.description) lines.push(prompt.description);
  lines.push("", `source: ${prompt.source}`);
  if (prompt.argumentHint) lines.push(`args:   ${prompt.argumentHint}`);
  lines.push("", "--- prompt ---", "", prompt.body);
  return lines.join("\n");
}
