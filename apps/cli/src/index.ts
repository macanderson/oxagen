#!/usr/bin/env tsx
/**
 * The `oxagen` executable's entry. It decides one thing, before anything
 * else loads: whether this is a machine command or a command a person runs.
 *
 * The machine commands are the ones the recorder writes into a machine's
 * configuration (#4879): a harness runs `oxagen hook` on every tool call, the
 * user service runs `oxagen daemon`, a connected app runs `oxagen
 * mcp-stdio`, Claude Code runs `oxagen credential issue` for its model
 * token, and git runs `oxagen github credential`. `arp` rides along because
 * it is the recorder's too. Each goes straight to the recorder, without the
 * command tree, the usage telemetry, or the fatal-error handlers of
 * `main.ts`, and none appears in `oxagen --help`. Their stdout belongs to
 * the program that runs them.
 *
 * This file imports nothing statically, so `oxagen hook` loads this module,
 * `machine/hook.ts`, and the recorder's hook, and nothing else
 * (`src/__tests__/hook-entry.test.ts` pins that).
 */
const MACHINE_COMMANDS = ["daemon", "mcp-stdio", "credential", "github", "arp"];

const command = process.argv[2];

if (command === "hook") {
  import("./machine/hook.js")
    .then(({ runHook }) => runHook(process.argv))
    .catch(() => {
      // A hook always answers, so a harness never reads a crash as a verdict.
      process.stdout.write("{}\n");
      process.exitCode = 0;
    });
} else if (command !== undefined && MACHINE_COMMANDS.includes(command)) {
  import("./machine/recorder.js")
    .then(({ runRecorderCommand }) => runRecorderCommand(process.argv))
    .catch((error: unknown) => {
      process.stderr.write(
        `oxagen ${command}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
} else {
  import("./main.js")
    .then(({ runCli }) => runCli())
    .catch((error: unknown) => {
      process.stderr.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
