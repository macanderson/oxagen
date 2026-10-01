/**
 * The `tacho`, `tachod`, and `tacho-hook` executables are hidden aliases of
 * the `oxagen` CLI (#4879). Machines enrolled before the fold run them by
 * name from their harness hooks and their user service, so each keeps
 * working until `oxagen agent enroll` or `oxagen agent status` moves that
 * machine to the new names. A person who types one is told, in one line on
 * stderr, which `oxagen` command replaced it.
 *
 * The notice never goes to stdout: a harness reads the hook's answer there,
 * a connected app reads MCP there, and Claude Code reads its model token
 * there. A command that a harness, git, or a connected app runs prints the
 * notice only when stdin is a terminal, which means a person typed it. The
 * desktop app still drives the old `tacho` sidecar and streams its stderr
 * into the app's log, so a sidecar it starts (`OXAGEN_DESKTOP_SIDECAR=1`,
 * set by `cli_install::sidecar_env_for`) prints nothing.
 *
 * This file is the one place in the recorder allowed to spell the old
 * commands (`tools/scripts/check-tacho-commands.mjs`).
 */

/** The executables the alias notice covers. */
export type AliasExecutable = "tacho" | "tachod" | "tacho-hook";

/** Where each `tacho` command moved in the `oxagen` CLI. */
export const OXAGEN_COMMAND_FOR: Readonly<Record<string, string>> = {
  enroll: "oxagen agent enroll",
  status: "oxagen agent status",
  unenroll: "oxagen agent unenroll",
  reassign: "oxagen agent reassign",
  export: "oxagen agent export",
  verify: "oxagen agent verify",
  run: "oxagen agent run",
  detect: "oxagen agent detect",
  daemon: "oxagen daemon",
  hook: "oxagen hook",
  "mcp-stdio": "oxagen mcp-stdio",
  credential: "oxagen credential",
  github: "oxagen github",
  arp: "oxagen arp",
};

/**
 * Commands another program runs and reads the output of: a harness runs
 * `hook`, a connected app runs `mcp-stdio`, Claude Code runs `credential
 * issue`, and git runs `github credential`. Each prints the notice only for
 * a person at a terminal.
 */
const MACHINE_COMMANDS = new Set(["hook", "mcp-stdio", "credential", "github"]);

/**
 * The one line an alias prints, or undefined when it prints nothing.
 * `argv` is `process.argv`, so the command is `argv[2]`.
 */
export function aliasNotice(
  executable: AliasExecutable,
  argv: readonly string[],
  stdinIsTTY: boolean,
  env: Record<string, string | undefined> = {},
): string | undefined {
  if (env["OXAGEN_DESKTOP_SIDECAR"] === "1") return undefined;
  if (executable === "tachod")
    // The service manager starts it and its stderr goes to the log, where
    // the line tells whoever reads the log what to run.
    return "tachod is now `oxagen daemon`. Run `oxagen agent status` to move this machine's service to the new name.";
  if (executable === "tacho-hook")
    return stdinIsTTY ? "tacho-hook is now `oxagen hook`." : undefined;
  const command = argv[2];
  const replacement =
    command === undefined ? undefined : OXAGEN_COMMAND_FOR[command];
  if (command === undefined || replacement === undefined)
    return "tacho is now the `oxagen` CLI. Run `oxagen agent --help` for the commands that replaced it.";
  if (MACHINE_COMMANDS.has(command) && !stdinIsTTY) return undefined;
  // tacho-command-check: alias (this line names the old spelling on purpose)
  return `\`tacho ${command}\` is now \`${replacement}\`. The old name still works.`;
}

/** Print `aliasNotice` to stderr, when there is one. */
export function printAliasNotice(
  executable: AliasExecutable,
  argv: readonly string[] = process.argv,
  stdinIsTTY: boolean = process.stdin.isTTY === true,
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
  env: Record<string, string | undefined> = process.env,
): void {
  const notice = aliasNotice(executable, argv, stdinIsTTY, env);
  if (notice !== undefined) write(`${notice}\n`);
}
