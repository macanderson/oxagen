/**
 * command — manage and run user-defined slash commands.
 *
 *   oxagen command list                List available slash commands
 *   oxagen command show <name>         Show a command's template
 *   oxagen command new <name>          Scaffold .oxagen/commands/<name>.toml
 *   oxagen command run <name> [args…]  Expand the template and run it as a turn
 *
 * In the interactive REPL, the same commands are invoked as `/name args`.
 *
 * Output discipline (ADR-023 §4): the list / template / scaffold result is the
 * answer and goes to stdout via the writer (so it is REPL-bridge safe) — `--json`
 * emits one single-line JSON value (shape preserved: list → summary array, show →
 * the command, new → `{name,path,created}`), pretty mode renders the human view.
 * A bad name exits 2 (usage) and an unknown command exits 1, both as uniform
 * stderr error lines that never touch stdout. `command run` delegates the turn
 * itself to runOneShot, which owns its own streaming output.
 */
import {
  loadCommands,
  scaffoldCommand,
  loadAndExpand,
  type SlashCommand,
  type LoadCommandsOptions,
} from "../slash/index.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export type CommandCmdCtx = Pick<
  LoadCommandsOptions,
  "cwd" | "userCommandsDir"
> & {
  /** `--json`: emit the result as one machine-readable JSON value on stdout (ADR-023 §4). */
  json?: boolean;
};

/** Compact per-command record for `command list --json` (template omitted — that's `show`). */
interface CommandSummary {
  name: string;
  description: string;
  argumentHint: string | null;
  source: string;
  model: string | null;
}

function summarizeCommand(c: SlashCommand): CommandSummary {
  return {
    name: c.name,
    description: c.description,
    argumentHint: c.argumentHint ?? null,
    source: c.source,
    model: c.model ?? null,
  };
}

export function commandList(
  ctx: CommandCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const commands = [...loadCommands(ctx).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  out.data(commands.map(summarizeCommand), () => prettyCommandList(commands));
}

export function commandShow(
  name: string,
  ctx: CommandCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const command = loadCommands(ctx).get(name);
  if (!command) {
    out.error(
      `Unknown command "/${name}". Run \`oxagen command list\`.`,
      "not_found",
    );
    return;
  }
  out.data(command, () => prettyCommand(command));
}

export function commandNew(
  name: string,
  ctx: CommandCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
    // Malformed input → usage error (exit 2). Set before out.error so it wins.
    process.exitCode = 2;
    out.error(
      `Invalid command name "${name}". Use letters, digits, dashes, underscores.`,
      "usage",
    );
    return;
  }
  const { path, created } = scaffoldCommand({ name, cwd: ctx.cwd });
  // The scaffold outcome IS the command's result → stdout via out.data; the
  // human "created/exists" line lives only in the pretty renderer.
  out.data({ name, path, created }, () =>
    created
      ? `✓ Created command ${path}\n  Edit it, then run: oxagen command run ${name} <args>  (or /${name} in the REPL)`
      : `${path} already exists — left untouched.`,
  );
}

export async function commandRun(
  name: string,
  args: string[],
  ctx: CommandCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: ctx.json }, writer);
  const invocation = `/${name}${args.length ? " " + args.join(" ") : ""}`;
  const expanded = loadAndExpand(invocation, ctx);
  if (expanded === null) {
    out.error(
      `Unknown command "/${name}". Run \`oxagen command list\`.`,
      "not_found",
    );
    return;
  }
  if ("error" in expanded) {
    // A malformed invocation → usage error (exit 2). Set before out.error so it wins.
    process.exitCode = 2;
    out.error(expanded.error, "usage");
    return;
  }
  // ADR-019 §4: running a command expands to an agent turn — require an account.
  // The turn's own streaming output belongs to runOneShot, not this writer.
  const { requireSession } = await import("../lib/session.js");
  const session = requireSession();
  const { runOneShot } = await import("../repl/one-shot.js");
  await runOneShot(expanded.prompt, { session, model: expanded.model });
}

function prettyCommandList(commands: SlashCommand[]): string {
  if (commands.length === 0) {
    return "No slash commands defined. Create one with `oxagen command new <name>`.";
  }
  const lines: string[] = ["Slash commands:", ""];
  for (const c of commands) {
    lines.push(`  /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`);
    if (c.description) lines.push(`    ${c.description}`);
  }
  return lines.join("\n");
}

function prettyCommand(command: SlashCommand): string {
  const lines: string[] = [`# /${command.name}`];
  if (command.description) lines.push(command.description);
  lines.push("", `source: ${command.source}`);
  if (command.argumentHint) lines.push(`args:   ${command.argumentHint}`);
  if (command.model) lines.push(`model:  ${command.model}`);
  lines.push("", "--- template ---", "", command.template);
  return lines.join("\n");
}
