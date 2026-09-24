/**
 * The daemon process body: run the collector in the foreground until
 * SIGTERM, writing the pid file and refreshing the bundle on SIGHUP. Shared
 * by the `tachod` executable and `tacho daemon` (the compiled single binary
 * is multi-call, so the service unit runs `tacho daemon`).
 */
import { writeFileSync } from "node:fs";
import { tachoPaths } from "../host/paths";
import { startDaemon } from "./daemon";

/**
 * How long the daemon waits for `stop()` after SIGTERM or SIGINT before it
 * exits anyway. `stop()` awaits the git reconciliation lane, which can run
 * for minutes. A re-enroll boots the old daemon out of launchd and waits for
 * it to go before it loads the new one, so a slow stop there holds up the
 * enroll, and launchd's and systemd's own kill timeouts are 10 s
 * (`host/service.ts`). `stop()` persists `state.json` before that wait, so
 * exiting early loses the final seal of the host chain and nothing else.
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

export async function runDaemonProcess(): Promise<void> {
  const paths = tachoPaths(process.env);
  const daemon = await startDaemon({ paths });
  writeFileSync(paths.pid, `${process.pid}\n`);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`tachod: ${signal}, stopping\n`);
    stopWithin(
      () => daemon.stop(),
      STOP_GRACE_MS,
      (code) => process.exit(code),
      (line) => process.stderr.write(line),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => {
    daemon.refreshBundle().catch(() => undefined);
  });
  await new Promise<void>(() => undefined);
}
