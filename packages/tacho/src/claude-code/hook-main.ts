/**
 * `tacho-hook` entry: the command hook Claude Code runs for enforcement
 * events. Reads stdin, answers on stdout, exits 0 with a JSON decision.
 */
import { tachoPaths } from "../host/paths";
import { runTachoHook } from "./hook-client";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(): Promise<void> {
  const stdin = await readStdin();
  const result = await runTachoHook({
    paths: tachoPaths(process.env),
    env: process.env,
    stdin,
  });
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  process.stderr.write(
    `tacho-hook: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stdout.write("{}\n");
  process.exitCode = 0;
});
