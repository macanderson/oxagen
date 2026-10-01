/**
 * `tacho-hook` entry: the command hook Claude Code and Codex run for
 * enforcement events and `SessionEnd`, on machines enrolled before the
 * `oxagen` CLI took the recorder's commands (#4879). New enrollments run
 * `oxagen hook`. The body lives in `hook-process.ts`, so both names run the
 * same code.
 */
import { printAliasNotice } from "../cli/alias";
import { runHookProcess } from "./hook-process";

printAliasNotice("tacho-hook");
runHookProcess().catch(() => {
  process.stdout.write("{}\n");
  process.exitCode = 0;
});
