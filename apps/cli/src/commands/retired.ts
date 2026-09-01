/**
 * retired.ts — the one shared notice for commands removed in the Stella
 * cutover. Oxagen's own terminal coding agent is gone: Stella owns all things
 * agentic, and the platform commands that remain here talk to Oxagen over the
 * API. Every retired entry point prints this single line and exits non-zero so
 * scripts fail loudly instead of silently doing nothing.
 */
export function printRetiredNotice(what: string): void {
  process.stderr.write(
    `${what} was retired in the Stella cutover. Use the \`stella\` CLI with the oxagen MCP server instead (see docs/specs/agent-engine-v2/).\n`,
  );
  process.exitCode = 1;
}
