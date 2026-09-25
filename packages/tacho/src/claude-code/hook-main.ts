/**
 * `tacho-hook` entry: the command hook Claude Code and Codex run for
 * enforcement events and `SessionEnd`. The body lives in `hook-process.ts`
 * so the compiled single binary can expose it as `tacho hook`.
 */
import { runHookProcess } from "./hook-process";

runHookProcess().catch(() => {
  process.stdout.write("{}\n");
  process.exitCode = 0;
});
