/**
 * Entry of the compiled single binary (`scripts/bundle.mjs` → `tools/sea`).
 * One executable, multi-call: `tacho enroll`, `tacho daemon`, `tacho hook`.
 * `main.ts` skips its own auto-run under a native build, so this is the
 * only place the program starts.
 *
 * `hook` is dispatched before commander is built: it runs on every tool
 * call, and `buildTachoProgram()` probes the filesystem for the CLI's deps
 * that the hook never needs.
 */
import { runHookProcess } from "../claude-code/hook-process";
import { main } from "./main";

const command = process.argv[2];
const start = command === "hook" ? runHookProcess(process.argv) : main();

start.catch((error) => {
  process.stderr.write(
    `tacho: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
