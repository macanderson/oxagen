/**
 * Move every agent on this machine whose hooks or service still run a
 * `tacho` executable to `oxagen hook` and `oxagen daemon` (#4879). Enrolling
 * and `oxagen agent status` both call this, so a machine enrolled before the
 * fold moves the first time a person runs either.
 *
 * It reports on stderr, one line per agent, so `--json` output stays
 * parseable. The re-apply's own step lines are dropped; its errors are not.
 */
import type { CommandWriter } from "../lib/capture-writer.js";

export async function moveOffTacho(writer: CommandWriter): Promise<void> {
  const { defaultCliDeps, moveOffTachoNames, oxagenRuntimeCommands } =
    await import("@oxagen/recorder/cli");
  const moved = await moveOffTachoNames(
    defaultCliDeps({
      out: () => undefined,
      err: (line) => writer.writeErr(line),
      runtime: oxagenRuntimeCommands(),
    }),
  );
  for (const agent of moved)
    writer.writeErr(
      agent.ok
        ? `Moved ${agent.agentKey}'s hooks and service from ${agent.from} to the oxagen CLI.`
        : `Could not move ${agent.agentKey}'s hooks and service off ${agent.from}; they keep working. Run \`oxagen agent enroll\` to try again.`,
    );
}
