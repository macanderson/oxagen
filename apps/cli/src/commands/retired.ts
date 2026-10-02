/**
 * retired.ts — the one shared notice for every command removed when the agent
 * runtime was excised (ADR-043). Oxagen governs, grounds, explains, meters and
 * rates agents; it does not run them. Stella owns all things agentic, and the
 * governance commands that remain here talk to Oxagen over the platform API.
 *
 * Every retired entry point prints this single line and exits non-zero so
 * scripts fail loudly instead of silently doing nothing.
 */
export function printRetiredNotice(what: string): void {
  process.stderr.write(
    `${what} was retired when Oxagen became a pure governance plane (docs/adr/ADR-043-runtime-excision.md). Use the \`stella\` CLI with the oxagen MCP server instead.\n`,
  );
  process.exitCode = 1;
}

/**
 * The notice for a command in the hidden `oxagen tacho` group, which became
 * `oxagen agent` (ADR-112 phase 1, #4879). It differs from
 * `printRetiredNotice` in both halves: it leaves the exit code alone, because
 * the command runs and a script that depends on it keeps passing, and it
 * names the command that replaced the one typed.
 *
 * Naming the replacement is the point. Hiding the old spelling from `--help`
 * takes away the operator's other way of finding the new one, so this line is
 * the migration guidance rather than a courtesy. One line, on stderr, so it
 * never lands in the output of a `--json` subcommand a script is parsing.
 * A desktop app built before #4891 sends `oxagen tacho reassign --default`
 * and streams the sidecar's stderr into its log, so a sidecar it starts
 * (`OXAGEN_DESKTOP_SIDECAR=1`) prints nothing: the person reading that log
 * did not type the command. The current app sends `oxagen agent reassign`.
 */
export function printTachoAliasNotice(
  subcommand: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env["OXAGEN_DESKTOP_SIDECAR"] === "1") return;
  process.stderr.write(
    // tacho-command-check: alias (this line names the old spelling on purpose)
    `\`oxagen tacho ${subcommand}\` is now \`oxagen agent ${subcommand}\`. The old name still works.\n`,
  );
}
