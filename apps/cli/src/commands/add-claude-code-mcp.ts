/**
 * Give Claude Code Oxagen's MCP server on each live agent enrolled before
 * enroll wrote it (#5287). `oxagen agent status` calls this, so a machine
 * gains the server the first time a person runs status, or the first time
 * the desktop app polls status after it updates. Enrolling writes the
 * server itself, so enroll does not call this.
 *
 * It reports on stderr, one line per agent, so `--json` output stays
 * parseable.
 */
import type { CommandWriter } from "../lib/capture-writer.js";

export async function addClaudeCodeMcp(writer: CommandWriter): Promise<void> {
  const { addMissingClaudeCodeMcp, defaultCliDeps, oxagenRuntimeCommands } =
    await import("@oxagen/recorder/cli");
  let added: ReturnType<typeof addMissingClaudeCodeMcp>;
  try {
    added = addMissingClaudeCodeMcp(
      defaultCliDeps({
        out: () => undefined,
        err: (line) => writer.writeErr(line),
        runtime: oxagenRuntimeCommands(),
      }),
    );
  } catch (error) {
    // Status reports the machine either way; this step is a repair.
    writer.writeErr(
      `Could not check Claude Code for Oxagen's MCP server: ${error instanceof Error ? error.message : String(error)}. Run \`oxagen agent enroll\` to add it.`,
    );
    return;
  }
  for (const agent of added)
    writer.writeErr(
      agent.ok
        ? `Added Oxagen's MCP server to Claude Code for ${agent.agentKey} in ${agent.path}. New Claude Code sessions list Oxagen's tools.`
        : `Could not add Oxagen's MCP server to Claude Code for ${agent.agentKey}: ${agent.problem ?? "unknown reason"}. The hooks keep working. Run \`oxagen agent enroll\` to try again.`,
    );
}
