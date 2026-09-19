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
 * The notice for a command that has been renamed and still works (ADR-111
 * phase 1). It differs from `printRetiredNotice` in both halves: it leaves the
 * exit code alone, because the command runs and a script that depends on it
 * keeps passing, and it names the replacement.
 *
 * Naming the replacement is the point. Hiding the old spelling from `--help`
 * takes away the operator's other way of finding the new one, so this line is
 * the migration guidance rather than a courtesy. "Moving to" rather than "moved
 * to" on purpose: the commands land on the new group in a later phase, and
 * promising a command that does not accept the same invocation yet would send
 * the reader somewhere that fails.
 */
export function printDeprecatedNotice(what: string, replacement: string): void {
  process.stderr.write(
    `${what} is deprecated and will be removed in a later release. Its commands are moving to ${replacement}; this one still works today.\n`,
  );
}
