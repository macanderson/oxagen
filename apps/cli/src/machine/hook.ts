/**
 * `oxagen hook`: the command hook every wrapped harness runs on each tool
 * call (#4879). It imports the recorder's hook and nothing else, because
 * loading the CLI's command tree here would add its start-up time to every
 * tool call an agent makes. `src/__tests__/hook-entry.test.ts` pins the
 * import graph.
 */
import { runHookProcess } from "@oxagen/recorder/hook";

/** Read the payload on stdin, answer on stdout, exit 0. */
export function runHook(argv: readonly string[]): Promise<void> {
  return runHookProcess(argv);
}
