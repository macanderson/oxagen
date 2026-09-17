/**
 * The hook process body: read the harness payload from stdin, answer on
 * stdout, always exit 0 with a JSON decision. Shared by the `tacho-hook`
 * executable and `tacho hook` (the compiled single binary is multi-call, so
 * the settings writers install `tacho hook --enrollment ... [--harness ...]`;
 * a custom agent runs `tacho hook --agent <name>`).
 */
import { tachoPaths } from "../host/paths";
import { agentFromArgv, harnessFromArgv, runTachoHook } from "./hook-client";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHookProcess(
  argv: readonly string[] = process.argv,
): Promise<void> {
  try {
    const stdin = await readStdin();
    const result = await runTachoHook({
      paths: tachoPaths(process.env),
      env: process.env,
      stdin,
      harness: harnessFromArgv(argv),
      ...(agentFromArgv(argv) !== undefined
        ? { agent: agentFromArgv(argv) as string }
        : {}),
      platform: process.platform,
    });
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(
      `tacho-hook: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stdout.write("{}\n");
    process.exitCode = 0;
  }
}
