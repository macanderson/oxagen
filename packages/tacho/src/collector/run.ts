/**
 * The daemon process body: run the collector in the foreground until
 * SIGTERM, writing the pid file and refreshing the bundle on SIGHUP. Shared
 * by `oxagen daemon` and its hidden aliases, the `tachod` executable and
 * `tacho daemon` from the compiled single binary (#4879). A service unit
 * written by `oxagen agent enroll` runs `oxagen daemon`.
 *
 * One process serves every agent on the machine (ADR-203): a collector per
 * agent, each on its own ports and with its own state, under one service,
 * one pid file and one log.
 */
import { readFileSync, unlinkSync } from "node:fs";
import {
  agentServes,
  listAgents,
  migrateLegacyLayout,
} from "../host/agents";
import { writeSensitiveFileAtomic } from "../host/fs";
import type { TachoHome, TachoPaths } from "../host/paths";
import { tachoHome } from "../host/paths";
import {
  formatDaemonPid,
  parseDaemonPid,
  readProcessStarts,
} from "../host/process-scan";
import { type DaemonHandle, type DaemonOptions, startDaemon } from "./daemon";

/**
 * How long the daemon waits for `stop()` after SIGTERM or SIGINT before it
 * exits anyway. A re-enroll boots the old daemon out of launchd and waits for
 * it to go before it loads the new one, so a slow stop there holds up the
 * enroll, and launchd's and systemd's own kill timeouts are 10 s
 * (`host/service.ts`). `stop()` bounds its own waits inside this: at most
 * `stopLaneMs` for the git reconciliation lane, which can run for minutes,
 * `stopQueueMs` for the hook queue to reach the host chain's seal, and
 * `stopDrainMs` for shipping.
 */
export const STOP_GRACE_MS = 5_000;

/**
 * Run `stop` and exit: 0 when it finishes, 1 when it fails or when it has
 * not finished within `graceMs`. Ports are injected so a test can drive it.
 */
export function stopWithin(
  stop: () => Promise<void>,
  graceMs: number,
  exit: (code: number) => void,
  log: (line: string) => void,
): void {
  const timer = setTimeout(() => {
    log(`tachod: stop did not finish within ${graceMs} ms, exiting\n`);
    exit(1);
  }, graceMs);
  stop()
    .then(() => {
      clearTimeout(timer);
      exit(0);
    })
    .catch((error) => {
      clearTimeout(timer);
      log(
        `tachod: stop failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      exit(1);
    });
}

export interface ProcessGuardOptions {
  /** Stop the daemon: persist its state and close its listeners. */
  stop: () => Promise<void>;
  /** End the process with this code. */
  exit: (code: number) => void;
  /** Write one line; each line ends in a newline, as `stopWithin`'s do. */
  log: (line: string) => void;
  /** `STOP_GRACE_MS` unless a test says. */
  stopTimeoutMs?: number;
  /** Where the handlers are registered; the process unless a test says. */
  target?: Pick<NodeJS.EventEmitter, "on" | "off">;
}

function describeError(value: unknown): string {
  return value instanceof Error
    ? (value.stack ?? value.message)
    : String(value);
}

/**
 * One process serves every agent's model proxy, so an error nothing caught
 * must not end it by accident. Without these handlers Node exits on the
 * first stray rejection (a malformed request line reaching `new URL()`, one
 * of the daemon's fire-and-forget lanes) and every harness gets connection
 * refused until the service manager restarts it. An unhandled rejection is
 * logged and the process keeps serving. An uncaught exception leaves the
 * process in a state nothing vouches for, so it is logged, the daemon gets
 * the same bounded stop a SIGTERM gets (`stopWithin`), and the process
 * exits 1 for the service manager to start a fresh one. Returns a function
 * that removes both.
 */
export function guardDaemonProcess(options: ProcessGuardOptions): () => void {
  const target = options.target ?? process;
  let crashing = false;
  const onRejection = (reason: unknown) => {
    options.log(`tachod: unhandled rejection: ${describeError(reason)}\n`);
  };
  const onException = (error: unknown) => {
    options.log(`tachod: uncaught exception: ${describeError(error)}\n`);
    if (crashing) return;
    crashing = true;
    stopWithin(
      // A stop that throws synchronously counts as a failed stop, so this
      // handler never throws itself.
      () => Promise.resolve().then(() => options.stop()),
      options.stopTimeoutMs ?? STOP_GRACE_MS,
      () => options.exit(1),
      options.log,
    );
  };
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}

/**
 * Record this process in `tachod.pid`: its pid, when it wrote the record,
 * its executable, and on Linux its start as `/proc` counts it (`start`). The
 * file is replaced whole through a rename, so a service manager that reads
 * it while the daemon starts sees the old record or this one, never an empty
 * or half-written file.
 */
export function writeDaemonPid(
  path: string,
  now: Date = new Date(),
  execPath: string = process.execPath,
  start?: string,
): void {
  writeSensitiveFileAtomic(
    path,
    formatDaemonPid({
      pid: process.pid,
      started_at: now.toISOString(),
      exe: execPath,
      ...(start !== undefined ? { start } : {}),
    }),
    0o644,
  );
}

/** This process's start as `/proc` counts it, on Linux only. */
function ownProcStart(): string | undefined {
  if (process.platform !== "linux") return undefined;
  return readProcessStarts([process.pid], undefined, "linux")?.get(
    process.pid,
  );
}

/** A file's text, or undefined when there is none to read. */
function readPidFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Give up `tachod.pid` as the daemon exits, so the file never outlives it to
 * name a pid the OS may give to another program. `previous` is what the file
 * held before this process wrote it, put back when this process never
 * started serving: a second daemon that fails on the first one's ports must
 * not leave the first with no record to be stopped by. A file a newer daemon
 * has written since is left alone.
 */
export function releaseDaemonPid(path: string, previous?: string): void {
  try {
    if (parseDaemonPid(readFileSync(path, "utf8"))?.pid !== process.pid)
      return;
    if (previous === undefined) unlinkSync(path);
    else writeSensitiveFileAtomic(path, previous, 0o644);
  } catch {
    // Gone already, or unreadable: nothing of this process to remove.
  }
}

/** One agent this process runs a collector for. */
export interface DaemonAgent {
  /** The agent's directory name under `agents/`. */
  id: string;
  paths: TachoPaths;
  /** Whether this agent's detector watches Claude Code's transcripts. */
  watchesTranscripts: boolean;
}

/**
 * The agents this process serves (ADR-203): every agent that has not been
 * retired on this machine (`agentServes`). When every agent is retired, the
 * first one runs as a lone enrollment always has: its revoke may still be
 * pending. Beside a live agent, a retired one waits for
 * its revoke without a collector, since it would otherwise run on a key its
 * unenroll gave up, on ports it no longer holds. None when the machine holds
 * no agent.
 *
 * One agent watches Claude Code's transcripts: the one that hooks Claude
 * Code, else the first. Two watchers would each report the same unhooked
 * session, and each would list processes on every tick.
 */
export function daemonAgents(home: TachoHome): DaemonAgent[] {
  const agents = listAgents(home);
  const running = agents.filter(agentServes);
  const serving = running.length > 0 ? running : agents.slice(0, 1);
  const watcher =
    serving.find(
      (agent) =>
        agent.host?.revoked_at === null &&
        agent.host.harnesses.includes("claude-code"),
    ) ?? serving[0];
  return serving.map((agent) => ({
    id: agent.id,
    paths: agent.paths,
    watchesTranscripts: agent === watcher,
  }));
}

/**
 * Start a collector for each agent, pushing each onto `started` as it comes
 * up so a stop reaches it. An agent that fails is logged and the rest still
 * start, because one agent's broken `host.json` must not take the others'
 * hooks down. Throws the first failure when no agent started.
 */
export async function startAgents(
  agents: readonly DaemonAgent[],
  started: DaemonHandle[],
  log: (line: string) => void,
  start: (options: DaemonOptions) => Promise<DaemonHandle> = startDaemon,
): Promise<void> {
  let firstError: unknown;
  for (const agent of agents) {
    try {
      started.push(
        await start({
          paths: agent.paths,
          // Each enrollment pulls its own local-server calls (#4773).
          localServers: true,
          ...(agent.watchesTranscripts ? {} : { transcriptRoots: [] }),
          ...(agents.length > 1 ? { log: agentLog(agent.id) } : {}),
        }),
      );
    } catch (error) {
      firstError ??= error;
      log(
        `tachod: agent ${agent.id} did not start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (started.length === 0)
    throw (
      firstError ??
      new Error("no enrollment on this machine; run `oxagen agent enroll` first")
    );
}

/**
 * A log whose lines name the agent, for a process that serves more than
 * one: the log is shared.
 */
function agentLog(id: string): (line: string) => void {
  return (line) => {
    process.stderr.write(
      `${new Date().toISOString()} tachod [${id}] ${line}\n`,
    );
  };
}

/** Stop every collector, and fail when any stop failed. */
export async function stopAll(daemons: readonly DaemonHandle[]): Promise<void> {
  const results = await Promise.allSettled(
    daemons.map((daemon) => daemon.stop()),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

export async function runDaemonProcess(): Promise<void> {
  const paths = tachoHome(process.env);
  const daemons: DaemonHandle[] = [];
  let stopping: Promise<void> | undefined;
  const stopOnce = () => (stopping ??= stopAll(daemons));
  // What `tachod.pid` held before this process wrote it, kept until a
  // collector is up.
  let previousPid = readPidFile(paths.pid);
  const exit = (code: number) => {
    releaseDaemonPid(paths.pid, previousPid);
    process.exit(code);
  };
  const log = (line: string) => {
    process.stderr.write(line);
  };
  guardDaemonProcess({ stop: stopOnce, exit, log });
  // A machine enrolled before ADR-203 keeps its enrollment in the tacho
  // directory. It moves into `agents/` here, before any collector reads it.
  // A move that fails part way is finished by the next start.
  try {
    const moved = migrateLegacyLayout(paths);
    if (moved !== undefined)
      log(`tachod: moved this machine's enrollment into agents/${moved}\n`);
  } catch (error) {
    log(
      `tachod: could not move the enrollment into agents/: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  // Written before any collector starts. The first collector answers hooks
  // while the rest start, and a reinstall in that window stops the daemon by
  // this file. Written after them, the file was missing, the stop killed
  // nothing, and a second daemon started beside this one.
  writeDaemonPid(paths.pid, new Date(), process.execPath, ownProcStart());
  try {
    await startAgents(daemonAgents(paths), daemons, log);
  } catch (error) {
    releaseDaemonPid(paths.pid, previousPid);
    throw error;
  }
  previousPid = undefined;
  const stop = (signal: string) => {
    if (stopping !== undefined) return;
    process.stderr.write(`tachod: ${signal}, stopping\n`);
    stopWithin(stopOnce, STOP_GRACE_MS, exit, log);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => {
    for (const daemon of daemons)
      daemon.refreshBundle().catch(() => undefined);
  });
  await new Promise<void>(() => undefined);
}
