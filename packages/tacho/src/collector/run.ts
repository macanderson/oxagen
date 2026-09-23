/**
 * The daemon process body: run the collector in the foreground until
 * SIGTERM, writing the pid file and refreshing the bundle on SIGHUP. Shared
 * by the `tachod` executable and `tacho daemon` (the compiled single binary
 * is multi-call, so the service unit runs `tacho daemon`).
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tachoPaths } from "../host/paths";
import { formatDaemonPid, parseDaemonPid } from "../host/process-scan";
import { startDaemon } from "./daemon";

/** How long a crash waits for the daemon to stop before it exits anyway. */
const CRASH_STOP_TIMEOUT_MS = 10_000;

export interface ProcessGuardOptions {
  /** Stop the daemon: persist its state and close its listeners. */
  stop: () => Promise<void>;
  /** End the process with this code. */
  exit: (code: number) => void;
  log: (line: string) => void;
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
 * a bounded chance to stop cleanly, and the process exits 1 for the service
 * manager to start a fresh one. Returns a function that removes both.
 */
export function guardDaemonProcess(options: ProcessGuardOptions): () => void {
  const target = options.target ?? process;
  let crashing = false;
  const onRejection = (reason: unknown) => {
    options.log(`tachod: unhandled rejection: ${describeError(reason)}`);
  };
  const onException = (error: unknown) => {
    options.log(`tachod: uncaught exception: ${describeError(error)}`);
    if (crashing) return;
    crashing = true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(
        resolve,
        options.stopTimeoutMs ?? CRASH_STOP_TIMEOUT_MS,
      );
    });
    const stopped = Promise.resolve()
      .then(() => options.stop())
      .catch((stopError: unknown) => {
        options.log(`tachod: stop failed: ${describeError(stopError)}`);
      });
    void Promise.race([stopped, timeout]).then(() => {
      clearTimeout(timer);
      options.exit(1);
    });
  };
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}

/** Record this process in `tachod.pid`: its pid, start and executable. */
export function writeDaemonPid(
  path: string,
  now: Date = new Date(),
  execPath: string = process.execPath,
): void {
  writeFileSync(
    path,
    formatDaemonPid({
      pid: process.pid,
      started_at: now.toISOString(),
      exe: execPath,
    }),
  );
}

/**
 * Remove `tachod.pid` as the daemon exits, so the file never outlives it to
 * name a pid the OS may give to another program. A file a newer daemon has
 * written since is left alone.
 */
export function releaseDaemonPid(path: string): void {
  try {
    if (parseDaemonPid(readFileSync(path, "utf8"))?.pid === process.pid)
      unlinkSync(path);
  } catch {
    // Gone already, or unreadable: nothing of this process to remove.
  }
}

export async function runDaemonProcess(): Promise<void> {
  const paths = tachoPaths(process.env);
  // Until the daemon has started there is nothing to stop.
  let stopDaemon = (): Promise<void> => Promise.resolve();
  let stopping: Promise<void> | undefined;
  const stopOnce = () => (stopping ??= stopDaemon());
  const exit = (code: number) => {
    releaseDaemonPid(paths.pid);
    process.exit(code);
  };
  guardDaemonProcess({
    stop: stopOnce,
    exit,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const daemon = await startDaemon({ paths });
  stopDaemon = () => daemon.stop();
  writeDaemonPid(paths.pid);
  const stop = (signal: string) => {
    if (stopping !== undefined) return;
    process.stderr.write(`tachod: ${signal}, stopping\n`);
    stopOnce()
      .then(() => exit(0))
      .catch((error) => {
        process.stderr.write(
          `tachod: stop failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => {
    daemon.refreshBundle().catch(() => undefined);
  });
  await new Promise<void>(() => undefined);
}
