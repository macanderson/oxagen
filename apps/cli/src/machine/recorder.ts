/**
 * The recorder's machine commands, run under the `oxagen` name (#4879):
 * `oxagen daemon` (what the user service runs), `oxagen mcp-stdio` (what a
 * connected app spawns), `oxagen credential issue` (Claude Code's model
 * credential helper), `oxagen github credential` (the Git credential helper),
 * and the rest of the `credential`, `github`, and `arp` groups.
 *
 * They run with `oxagenRuntimeCommands`, so anything they write into a
 * machine's configuration names `oxagen` too.
 */
import { oxagenRuntimeCommands } from "@oxagen/recorder/cli";
import { buildTachoProgram } from "@oxagen/recorder/program";

/** Parse `argv` (`process.argv`) with the recorder's command tree. */
export async function runRecorderCommand(
  argv: readonly string[],
): Promise<void> {
  await buildTachoProgram({
    name: "oxagen",
    deps: { runtime: oxagenRuntimeCommands() },
  }).parseAsync([...argv]);
}
