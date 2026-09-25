/**
 * The harness process behind a hook, for a harness that exports no pid of
 * its own. The daemon keys a session's liveness on that pid, seals the
 * session within one sweep once the process is gone, and sends it the
 * operator's `SIGTERM` on `cancel` (`collector/inbox.ts`). So a pid is passed
 * only when it names one process that runs one session. A process that
 * serves many sessions is worse than no pid: it would outlive every session
 * it serves, and a cancel of one session would end all of them.
 *
 * Stella's walk is `stellaHarnessPid` in `./stella-adapter.ts`, because
 * Stella's session id is built from the same pid.
 *
 * **Codex** runs a command hook as `<shell> -lc <command>`: the `-lc`
 * argument sits beside `hooks/src/engine/command_runner.rs` in the Codex
 * 0.156.1 binary. The hook's parent is that shell, or Codex itself when the
 * shell execs the command. The walk goes up to the first process whose name
 * is Codex's executable. `codex app-server`, the control channel the Codex
 * GUI drives (`host/codex-app-server.ts`), runs every thread of that GUI in
 * one process, so a hook under it gets no pid.
 *
 * **Cursor** gets no pid at all; see the comment in `runTachoHook`.
 */
import { spawnSync } from "node:child_process";
import { type PsLookup, psLookup } from "./stella-adapter";

/** A process's full command line, or undefined when `ps` cannot say. */
export type PsArgs = (pid: number) => string | undefined;

/** The real lookup: one `ps -o args=` call with a short timeout, stdin closed. */
export function psArgs(pid: number): string | undefined {
  const result = spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string")
    return undefined;
  const line = result.stdout.trim();
  return line.length > 0 ? line : undefined;
}

/**
 * Codex's executable: `codex`, or `codex-<target>` in the npm packages that
 * shipped one binary per platform. Linux's `ps` cuts `comm` at 15
 * characters, which leaves either form matching.
 */
const CODEX_EXECUTABLE = /^codex(-|$)/;

/**
 * Codex subcommands that serve many sessions from one process: the GUI's
 * `app-server`, and the MCP server modes (`mcp-server`, and `mcp` and `proto`
 * in older builds). A prompt that happens to contain one of these words also
 * matches, and that session falls back to the idle path, which is safe.
 */
const CODEX_SHARED_HOST = /(^|\s)(app-server|mcp-server|mcp|proto)(\s|$)/;

/** How far up the process tree the walk looks for Codex. */
const MAX_HOPS = 4;

/**
 * The pid of the Codex process that ran this hook, or undefined when the
 * walk cannot name exactly one per-session Codex process: on Windows, which
 * has no `ps`; when `ps` cannot answer; when no ancestor within
 * `MAX_HOPS` is Codex; and when the Codex process is a shared host.
 */
export function codexHarnessPid(
  parentPid: number,
  platform: NodeJS.Platform,
  lookup: PsLookup = psLookup,
  argsOf: PsArgs = psArgs,
): number | undefined {
  if (platform === "win32") return undefined;
  let pid = parentPid;
  for (let hop = 0; hop < MAX_HOPS && pid > 1; hop += 1) {
    const info = lookup(pid);
    if (info === undefined) return undefined;
    const name = info.comm.split("/").pop() ?? "";
    if (CODEX_EXECUTABLE.test(name)) {
      const args = argsOf(pid);
      return args === undefined || CODEX_SHARED_HOST.test(args)
        ? undefined
        : pid;
    }
    pid = info.ppid;
  }
  return undefined;
}
