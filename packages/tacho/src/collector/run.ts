/**
 * The daemon process body: run the collector in the foreground until
 * SIGTERM, writing the pid file and refreshing the bundle on SIGHUP. Shared
 * by the `tachod` executable and `tacho daemon` (the compiled single binary
 * is multi-call, so the service unit runs `tacho daemon`).
 */
import { writeFileSync } from "node:fs";
import { tachoPaths } from "../host/paths";
import { startDaemon } from "./daemon";

export async function runDaemonProcess(): Promise<void> {
  const paths = tachoPaths(process.env);
  const daemon = await startDaemon({ paths });
  writeFileSync(paths.pid, `${process.pid}\n`);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`tachod: ${signal}, stopping\n`);
    daemon
      .stop()
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(
          `tachod: stop failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => {
    daemon.refreshBundle().catch(() => undefined);
  });
  await new Promise<void>(() => undefined);
}
