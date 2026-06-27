/**
 * command — manage and run user-defined slash commands.
 *
 *   oxagen command list                List available slash commands
 *   oxagen command show <name>         Show a command's template
 *   oxagen command new <name>          Scaffold .oxagen/commands/<name>.md
 *   oxagen command run <name> [args…]  Expand the template and run it as a turn
 *
 * In the interactive REPL, the same commands are invoked as `/name args`.
 */
import { loadCommands, scaffoldCommand, loadAndExpand, type LoadCommandsOptions } from "../slash/index.js";

export type CommandCmdCtx = Pick<LoadCommandsOptions, "cwd" | "userCommandsDir">;

export function commandList(ctx: CommandCmdCtx = {}): void {
  const commands = [...loadCommands(ctx).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (commands.length === 0) {
    console.log("No slash commands defined. Create one with `oxagen command new <name>`.");
    return;
  }
  console.log("Slash commands:\n");
  for (const c of commands) {
    console.log(`  /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`);
    if (c.description) console.log(`    ${c.description}`);
  }
}

export function commandShow(name: string, ctx: CommandCmdCtx = {}): void {
  const command = loadCommands(ctx).get(name);
  if (!command) {
    console.error(`Unknown command "/${name}". Run \`oxagen command list\`.`);
    process.exitCode = 1;
    return;
  }
  console.log(`# /${command.name}`);
  if (command.description) console.log(command.description);
  console.log(`\nsource: ${command.source}`);
  if (command.argumentHint) console.log(`args:   ${command.argumentHint}`);
  if (command.model) console.log(`model:  ${command.model}`);
  console.log("\n--- template ---\n");
  console.log(command.template);
}

export function commandNew(name: string, ctx: CommandCmdCtx = {}): void {
  if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
    console.error(`Invalid command name "${name}". Use letters, digits, dashes, underscores.`);
    process.exitCode = 1;
    return;
  }
  const { path, created } = scaffoldCommand({ name, cwd: ctx.cwd });
  if (created) {
    console.log(`✓ Created command ${path}`);
    console.log(`  Edit it, then run: oxagen command run ${name} <args>  (or /${name} in the REPL)`);
  } else {
    console.log(`${path} already exists — left untouched.`);
  }
}

export async function commandRun(
  name: string,
  args: string[],
  ctx: CommandCmdCtx = {},
): Promise<void> {
  const invocation = `/${name}${args.length ? " " + args.join(" ") : ""}`;
  const expanded = loadAndExpand(invocation, ctx);
  if (expanded === null) {
    console.error(`Unknown command "/${name}". Run \`oxagen command list\`.`);
    process.exitCode = 1;
    return;
  }
  if ("error" in expanded) {
    console.error(`Error: ${expanded.error}`);
    process.exitCode = 1;
    return;
  }
  const { runOneShot } = await import("../repl/one-shot.js");
  await runOneShot(expanded.prompt, { model: expanded.model });
}
