/**
 * retired.ts — the one shared notice for every command removed when the agent
 * runtime was excised (ADR-041). Oxagen governs, grounds, explains, meters and
 * rates agents; it does not run them. Stella owns all things agentic, and the
 * governance commands that remain here talk to Oxagen over the platform API.
 *
 * Every retired entry point prints this single line and exits non-zero so
 * scripts fail loudly instead of silently doing nothing.
 */
export function printRetiredNotice(what: string): void {
  process.stderr.write(
    `${what} was retired when Oxagen became a pure governance plane (docs/adr/ADR-041-runtime-excision.md). Use the \`stella\` CLI with the oxagen MCP server instead.\n`,
  );
  process.exitCode = 1;
}
