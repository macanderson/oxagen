/**
 * The daemon process body: run the collector in the foreground until
 * SIGTERM, writing the pid file and refreshing the bundle on SIGHUP. Shared
 * by the `tachod` executable and `tacho daemon` (the compiled single binary
 * is multi-call, so the service unit runs `tacho daemon`).
 *
 * One process serves every enrollment on the machine (ADR-202): a collector
 * per slot, each on its own ports and with its own state, under one service,
 * one pid file and one log.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { TachoPaths } from "../host/paths";
import { tachoPaths } from "../host/paths";
import { formatDaemonPid, parseDaemonPid } from "../host/process-scan";
import { listSlots } from "../host/slots";
import type { TachoHarness } from "../wire";
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

/** One slot this process runs a collector for. */
export interface DaemonSlot {
  paths: TachoPaths;
  /** The harness the slot was made for; undefined for the root slot. */
  harness: TachoHarness | undefined;
  /** Whether this slot's detector watches Claude Code's transcripts. */
  watchesTranscripts: boolean;
}

/**
 * The slots this process serves (ADR-202): the root whenever it has a
 * `host.json`, as it always has, and each slot after it that has not been
 * retired on this machine. A machine with no enrollment at all still gets
 * the root, so its collector fails with the error that says to enroll.
 *
 * One slot watches Claude Code's transcripts: the one that hooks Claude
 * Code, else the root. Two watchers would each report the same unhooked
 * session, and each would list processes on every tick.
 */
export function daemonSlots(root: TachoPaths): DaemonSlot[] {
  const [first, ...rest] = listSlots(root);
  const later = rest.filter(
    (slot) => slot.host !== undefined && slot.host.revoked_at === null,
  );
  const slots =
    first !== undefined && (existsSync(root.hostFile) || later.length === 0)
      ? [first, ...later]
      : later;
  const watcher =
    slots.find(
      (slot) =>
        slot.host !== undefined &&
        slot.host.revoked_at === null &&
        slot.host.harnesses.includes("claude-code"),
    ) ?? slots.find((slot) => slot.harness === undefined);
  return slots.map((slot) => ({
    paths: slot.paths,
    harness: slot.harness,
    watchesTranscripts: slot === watcher,
  }));
}

/**
 * Start a collector for each slot, pushing each onto `started` as it comes
 * up so a stop reaches it. A slot that fails is logged and the rest still
 * start, because one agent's broken `host.json` must not take the others'
 * hooks down. Throws the first failure when no slot started.
 */
export async function startSlots(
  slots: readonly DaemonSlot[],
  started: DaemonHandle[],
  log: (line: string) => void,
  start: (options: DaemonOptions) => Promise<DaemonHandle> = startDaemon,
): Promise<void> {
  let firstError: unknown;
  for (const slot of slots) {
    try {
      started.push(
        await start({
          paths: slot.paths,
          ...(slot.watchesTranscripts ? {} : { transcriptRoots: [] }),
          ...(slot.harness !== undefined
            ? { log: slotLog(slot.harness) }
            : {}),
        }),
      );
    } catch (error) {
      firstError ??= error;
      log(
        `tachod: the ${slot.harness ?? "first"} enrollment did not start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (started.length === 0)
    throw firstError ?? new Error("no enrollment on this machine");
}

/** A later slot's log lines name its harness, since the log is shared. */
function slotLog(harness: TachoHarness): (line: string) => void {
  return (line) => {
    process.stderr.write(
      `${new Date().toISOString()} tachod [${harness}] ${line}\n`,
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
  const paths = tachoPaths(process.env);
  const daemons: DaemonHandle[] = [];
  let stopping: Promise<void> | undefined;
  const stopOnce = () => (stopping ??= stopAll(daemons));
  const exit = (code: number) => {
    releaseDaemonPid(paths.pid);
    process.exit(code);
  };
  const log = (line: string) => {
    process.stderr.write(line);
  };
  guardDaemonProcess({ stop: stopOnce, exit, log });
  await startSlots(daemonSlots(paths), daemons, log);
  writeDaemonPid(paths.pid);
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
